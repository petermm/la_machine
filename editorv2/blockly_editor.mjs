function getBlockly() {
  if (!window.Blockly) {
    throw new Error("Blockly is not available on window.");
  }
  return window.Blockly;
}

const BLOCK_COLORS = Object.freeze({
  servo: "#d66c4d",
  mp3: "#b87428",
  wait: "#7a8750"
});

function defineBlocks(Blockly) {
  if (Blockly.Blocks.lamachine_servo_fast && Blockly.Blocks.lamachine_servo_timed) {
    return;
  }

  Blockly.defineBlocksWithJsonArray([
    {
      type: "lamachine_servo_fast",
      message0: "move servo to %1 at fastest speed (%2)",
      args0: [
        {
          type: "field_number",
          name: "TARGET",
          value: 50,
          min: 0,
          max: 100,
          precision: 1
        },
        {
          type: "field_label_serializable",
          name: "ESTIMATE",
          text: "auto"
        }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: BLOCK_COLORS.servo,
      tooltip: "Servo move with no explicit duration. Output becomes {servo, target}.",
      helpUrl: ""
    },
    {
      type: "lamachine_servo_timed",
      message0: "move servo to %1 over %2 ms",
      args0: [
        {
          type: "field_number",
          name: "TARGET",
          value: 50,
          min: 0,
          max: 100,
          precision: 1
        },
        {
          type: "field_number",
          name: "DURATION",
          value: 250,
          min: 1,
          precision: 1
        }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: BLOCK_COLORS.servo,
      tooltip: "Servo move with an explicit duration. Output becomes {servo, target, duration}.",
      helpUrl: ""
    },
    {
      type: "lamachine_mp3",
      message0: "play mp3 %1",
      args0: [
        {
          type: "field_input",
          name: "PATH",
          text: "calm/01230.mp3"
        }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: BLOCK_COLORS.mp3,
      tooltip: "MP3 playback. Preview timing comes from loaded metadata or a fallback.",
      helpUrl: ""
    },
    {
      type: "lamachine_wait_ms",
      message0: "wait %1 ms",
      args0: [
        {
          type: "field_number",
          name: "DURATION",
          value: 250,
          min: 0,
          precision: 1
        }
      ],
      previousStatement: null,
      nextStatement: null,
      colour: BLOCK_COLORS.wait,
      tooltip: "Advance time by a fixed number of milliseconds.",
      helpUrl: ""
    },
    {
      type: "lamachine_wait_sound",
      message0: "wait until sound ends",
      previousStatement: null,
      nextStatement: null,
      colour: BLOCK_COLORS.wait,
      tooltip: "Advance time until the current audio clip is finished.",
      helpUrl: ""
    },
    {
      type: "lamachine_wait_servo",
      message0: "wait until servo settles",
      previousStatement: null,
      nextStatement: null,
      colour: BLOCK_COLORS.wait,
      tooltip: "Advance time until the current servo move is finished.",
      helpUrl: ""
    }
  ]);
}

function toolboxConfig() {
  return {
    kind: "categoryToolbox",
    contents: [
      {
        kind: "category",
        name: "Movement",
        categorystyle: "procedure_category",
        contents: [
          { kind: "block", type: "lamachine_servo_fast" },
          { kind: "block", type: "lamachine_servo_timed" }
        ]
      },
      {
        kind: "category",
        name: "Audio",
        categorystyle: "list_category",
        contents: [{ kind: "block", type: "lamachine_mp3" }]
      },
      {
        kind: "category",
        name: "Wait",
        categorystyle: "logic_category",
        contents: [
          { kind: "block", type: "lamachine_wait_ms" },
          { kind: "block", type: "lamachine_wait_sound" },
          { kind: "block", type: "lamachine_wait_servo" }
        ]
      }
    ]
  };
}

const WAIT_BLOCK_TYPE_BY_MODE = Object.freeze({
  duration: "lamachine_wait_ms",
  sound: "lamachine_wait_sound",
  servo: "lamachine_wait_servo"
});

function readIntegerField(block, fieldName) {
  return Number.parseInt(block.getFieldValue(fieldName), 10) || 0;
}

function writeRoundedField(block, fieldName, value) {
  block.setFieldValue(String(Math.round(value ?? 0)), fieldName);
}

function writeTextField(block, fieldName, value) {
  if (block.getField(fieldName)) {
    block.setFieldValue(String(value ?? ""), fieldName);
  }
}

const BLOCK_SPEC_BY_TYPE = {
  lamachine_servo_fast: {
    fillFromElement(block, element) {
      writeRoundedField(block, "TARGET", element.targetPercent);
      writeTextField(block, "ESTIMATE", "auto");
      block.setTooltip(
        "Servo move with no explicit duration. Runtime estimate depends on earlier servo timing."
      );
    },
    toElement(block) {
      return {
        type: "servo",
        targetPercent: readIntegerField(block, "TARGET"),
        durationMs: null,
        id: block.id
      };
    }
  },
  lamachine_servo_timed: {
    fillFromElement(block, element) {
      writeRoundedField(block, "TARGET", element.targetPercent);
      writeRoundedField(block, "DURATION", element.durationMs);
    },
    toElement(block) {
      return {
        type: "servo",
        targetPercent: readIntegerField(block, "TARGET"),
        durationMs: Math.max(1, readIntegerField(block, "DURATION")),
        id: block.id
      };
    }
  },
  lamachine_mp3: {
    fillFromElement(block, element) {
      block.setFieldValue(element.path ?? "", "PATH");
    },
    toElement(block) {
      return {
        type: "mp3",
        path: block.getFieldValue("PATH") || "",
        id: block.id
      };
    }
  },
  lamachine_wait_ms: {
    fillFromElement(block, element) {
      writeRoundedField(block, "DURATION", element.durationMs);
    },
    toElement(block) {
      return {
        type: "wait",
        mode: "duration",
        durationMs: readIntegerField(block, "DURATION"),
        id: block.id
      };
    }
  },
  lamachine_wait_sound: {
    toElement(block) {
      return {
        type: "wait",
        mode: "sound",
        durationMs: null,
        id: block.id
      };
    }
  },
  lamachine_wait_servo: {
    toElement(block) {
      return {
        type: "wait",
        mode: "servo",
        durationMs: null,
        id: block.id
      };
    }
  }
};

const STEP_BLOCK_TYPES = new Set(Object.keys(BLOCK_SPEC_BY_TYPE));

function blockTypeForElement(element) {
  if (element.type === "servo") {
    return Number.isFinite(element.durationMs) && element.durationMs > 0
      ? "lamachine_servo_timed"
      : "lamachine_servo_fast";
  }

  if (element.type === "mp3") {
    return "lamachine_mp3";
  }

  if (element.type !== "wait") {
    return null;
  }

  return WAIT_BLOCK_TYPE_BY_MODE[element.mode] ?? WAIT_BLOCK_TYPE_BY_MODE.duration;
}

function createStatementBlock(workspace, element) {
  const blockType = blockTypeForElement(element);
  const spec = blockType ? BLOCK_SPEC_BY_TYPE[blockType] : null;
  if (!spec) {
    return null;
  }

  const block = workspace.newBlock(blockType);
  spec.fillFromElement?.(block, element);
  block.initSvg();
  block.render();
  return block;
}

export function syncServoBlockEstimates(workspace, servoEvents = []) {
  const Blockly = getBlockly();
  const topBlocks = workspace
    .getTopBlocks(true)
    .filter((block) => STEP_BLOCK_TYPES.has(block.type));
  const eventById = new Map(servoEvents.map((event) => [event.id, event]));

  Blockly.Events.disable();
  try {
    for (const topBlock of topBlocks) {
      let block = topBlock;

      while (block) {
        if (block.type === "lamachine_servo_fast") {
          const event = eventById.get(block.id);
          if (event) {
            const motionEstimateMs = event.motionDurationMs ?? event.actualDurationMs;
            writeTextField(block, "ESTIMATE", `${Math.round(motionEstimateMs)} ms`);
            block.setTooltip(
              `Servo move with no explicit duration. Direct motion estimate from ${Math.round(event.startPercent)}% to ${Math.round(event.targetPercent)}% is ${Math.round(motionEstimateMs)} ms. Runtime settle time may be longer. Output becomes {servo, target}.`
            );
          } else {
            writeTextField(block, "ESTIMATE", "auto");
            block.setTooltip(
              "Servo move with no explicit duration. Runtime estimate depends on earlier servo timing."
            );
          }
        }

        block = block.getNextBlock();
      }
    }
  } finally {
    Blockly.Events.enable();
  }
}

function placeStackInView(workspace, firstBlock) {
  if (!firstBlock) {
    if (typeof workspace.scrollCenter === "function") {
      workspace.scrollCenter();
    }
    return;
  }

  if (typeof workspace.centerOnBlock === "function") {
    workspace.centerOnBlock(firstBlock.id);
    return;
  }

  const metrics = typeof workspace.getMetrics === "function" ? workspace.getMetrics() : null;
  const current = firstBlock.getRelativeToSurfaceXY();
  const targetX = (metrics?.viewLeft ?? 0) + 96;
  const targetY = (metrics?.viewTop ?? 0) + 48;
  firstBlock.moveBy(targetX - current.x, targetY - current.y);
}

export function sequenceToWorkspace(workspace, elements) {
  const Blockly = getBlockly();

  Blockly.Events.disable();
  try {
    if (typeof workspace.clear === "function") {
      workspace.clear();
    }

    let firstBlock = null;
    let previousBlock = null;
    for (const element of elements) {
      const block = createStatementBlock(workspace, element);
      if (!block) {
        continue;
      }
      if (!firstBlock) {
        firstBlock = block;
      }
      if (previousBlock) {
        previousBlock.nextConnection.connect(block.previousConnection);
      }
      previousBlock = block;
    }

    syncServoBlockEstimates(workspace);
    placeStackInView(workspace, firstBlock);

    if (typeof workspace.resizeContents === "function") {
      workspace.resizeContents();
    }
  } finally {
    Blockly.Events.enable();
  }
}

export function workspaceToSequence(workspace) {
  const elements = [];
  const topBlocks = workspace
    .getTopBlocks(true)
    .filter((block) => STEP_BLOCK_TYPES.has(block.type));

  for (const topBlock of topBlocks) {
    let block = topBlock;
    while (block) {
      const element = BLOCK_SPEC_BY_TYPE[block.type]?.toElement(block);
      if (element) {
        elements.push(element);
      }

      block = block.getNextBlock();
    }
  }

  return elements;
}

export function createBlocklyWorkspace(hostElement) {
  const Blockly = getBlockly();
  defineBlocks(Blockly);
  const workspace = Blockly.inject(hostElement, {
    toolbox: toolboxConfig(),
    trashcan: true,
    move: {
      scrollbars: true,
      drag: true,
      wheel: true
    },
    zoom: {
      controls: true,
      wheel: true,
      pinch: true,
      startScale: 0.95,
      maxScale: 1.6,
      minScale: 0.55
    },
    grid: {
      spacing: 20,
      length: 2,
      colour: "rgba(255, 255, 255, 0.08)",
      snap: false
    },
    theme: Blockly.Theme.defineTheme("lamachine", {
      base: Blockly.Themes.Zelos,
      componentStyles: {
        workspaceBackgroundColour: "#160f0b",
        toolboxBackgroundColour: "#211710",
        toolboxForegroundColour: "#f4ecdf",
        flyoutBackgroundColour: "#211710",
        flyoutForegroundColour: "#f4ecdf",
        flyoutOpacity: 0.96,
        scrollbarColour: "#7d5c3a",
        insertionMarkerColour: "#ffbf6a",
        insertionMarkerOpacity: 0.35
      }
    })
  });

  return { Blockly, workspace };
}

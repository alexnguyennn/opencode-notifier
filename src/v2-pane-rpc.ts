const text = { type: "string" } as const

export const paneRPC = {
  id: "opencode-notifier-pane",
  methods: {
    update: {
      input: {
        type: "object",
        properties: {
          clientID: text, sessionID: text, socketPath: text,
          paneID: text, appName: text, weztermPaneID: text,
          herdrPaneID: text, herdrSocketPath: text, herdrTerminalID: text, weztermUnixSocket: text,
        },
        required: ["clientID", "sessionID", "socketPath", "paneID", "appName", "weztermPaneID"],
        additionalProperties: false,
      },
      output: { type: "boolean" },
    },
    remove: {
      input: { type: "object", properties: { clientID: text }, required: ["clientID"], additionalProperties: false },
      output: { type: "boolean" },
    },
  },
  events: {},
} as const

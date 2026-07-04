// Agent Builder plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "./api.ts";
import { registerAgentBuilderGatewayMethods } from "./src/gateway.ts";
import { createAgentGitOps } from "./src/gitops.ts";
import { createAgentBuilderStore } from "./src/store.ts";
import { createAgentBuilderTools } from "./src/tools.ts";

export default definePluginEntry({
  id: "agent-builder",
  name: "Agent Builder",
  description:
    "Conversational agent builder: constrained tools that edit the canonical AgentSpec for Kagenti-deployed agents.",
  register(api) {
    const store = createAgentBuilderStore(api.runtime.state.openKeyedStore);
    const gitops = createAgentGitOps();
    registerAgentBuilderGatewayMethods({ api, store, gitops });
    for (const tool of createAgentBuilderTools(store, { gitops })) {
      api.registerTool(tool, { name: tool.name });
    }
  },
});

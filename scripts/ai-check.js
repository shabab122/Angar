import { loadConfig } from "../server/config.js";
import { assistantHealth } from "../server/chatbot-ollama.js";

try {
  const config = loadConfig();
  const result = await assistantHealth(config, true);
  console.log("Local AI endpoint:", config.chatbot.baseUrl);
  console.log("Configured local model:", config.chatbot.model);
  console.log("Status:", result.state);
  if (result.state === "ready")
    console.log(
      "Ollama is reachable and the local model is installed. Start the website, open Ask Angar, and send a question to test generation.",
    );
  else {
    console.log(
      "Keep Ollama running on the application server. Install the local model with: ollama pull " +
        config.chatbot.model,
    );
    console.log(
      "See UPGRADE_v2.10_BN.md. Basic menu help remains available while enabled.",
    );
    process.exitCode = 1;
  }
} catch {
  console.error(
    "Local AI configuration could not be checked. Run setup, review .env and see UPGRADE_v2.10_BN.md.",
  );
  process.exitCode = 1;
}

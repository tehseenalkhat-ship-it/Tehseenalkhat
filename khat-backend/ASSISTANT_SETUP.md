# Guild Guide assistant

The assistant is available to students, teachers, and coordinators throughout authenticated pages. It uses the existing database for the published course catalog and the signed-in user's own progress or teaching summary. It does not save chat history. The backend only sends the current user's recent messages and role-appropriate context to an optional model endpoint.

## Use the guided assistant without a model

No additional package, external account, API key, or model server is required. If no assistant model is configured, the built-in assistant answers common conversation (greetings, thanks, motivation), site navigation and workflows, course selection, and general Arabic-calligraphy and practice questions. It uses curated response rules and live course/user context, costs nothing per message, and sends no prompts to an external model. It is not unlimited open-ended language-model inference: for an unrecognized question it may ask the user to rephrase or consult a teacher/admin.

## Local development model

The local backend `.env` is configured to use Ollama at `http://localhost:11434/v1` with `qwen2.5:3b`. The model is not bundled with the app; install it once on this development machine:

1. Install Ollama and start its local service. The Ollama app normally keeps the service available after launch.
2. In a terminal, download the configured model with `ollama pull qwen2.5:3b`. This requires internet for the one-time model download and several GB of free disk space. Keep the model on this local computer; no external inference provider receives chat prompts.
3. Verify the model with `ollama list`, then restart the backend so it reads the local assistant settings.
4. The backend calls the local OpenAI-compatible endpoint. If Ollama is not running or the model is absent, it logs the issue and returns the guided site-help fallback instead.

For later organization-server deployment, change `ASSISTANT_BASE_URL` and `ASSISTANT_MODEL` to the model endpoint hosted by the organization. You may self-host Ollama on that server or use another OpenAI-compatible provider; if using an external provider, put its API key in the backend environment only, never in the frontend.

The system prompt limits answers to site help and the supplied data. Avoid putting private student information, credentials, or unrelated personal data into the model prompt. Course names and the current signed-in user's own progress are included to support recommendations. Teacher context is limited to their assigned scripts, open review count, completed review count, and their own event counts.

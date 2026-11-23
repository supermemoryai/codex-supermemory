// Detached OAuth login started by the SessionStart hook; see startBackgroundAuth.
import { startAuthFlow } from "../services/auth.js";

startAuthFlow(undefined, { background: true }).then(
  () => process.exit(0),
  () => process.exit(1),
);

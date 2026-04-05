/**
 * Glon OS — entry point.
 *
 * Registers all actor types and starts the Rivet runtime.
 * The OS is the registry. The registry is the OS.
 */

import { setup } from "rivetkit";
import { objectActor } from "./actors/object.js";
import { storeActor } from "./actors/store.js";

export const app = setup({
	use: { objectActor, storeActor },
});

app.start();

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import activateMultiAccount from "pi-multi-account";

/**
 * Load the upstream engine unchanged. The dashboard companion owns no provider
 * request or credential logic; it only supplies a settings surface.
 */
export default async function activate(pi: ExtensionAPI): Promise<void> {
  await activateMultiAccount(pi);
}

declare module "pi-multi-account" {
  import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
  export default function activate(pi: ExtensionAPI): void | Promise<void>;
}

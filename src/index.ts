// @aon/namespace-evm-spot
//
// EVM spot trading namespace for AON.
//
// Install alongside @aon/sdk:
//   npm install @aon/sdk @aon/namespace-evm-spot
//
// Register and use:
//   import { registerNamespace } from "@aon/sdk";
//   import { evmSpotNamespace } from "@aon/namespace-evm-spot";
//   registerNamespace(evmSpotNamespace);

export { evmSpotNamespace } from "./namespace.js";

export {
  buildEvmSpotAuthorizationObject,
  buildEvmSpotOrderObject,
  buildEvmSpotFillObject,
  buildEvmSpotRevocationObject,
} from "./builders.js";

export { findExecutableEvmSpotGraphs } from "./executableEvmSpot.js";

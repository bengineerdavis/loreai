import { log } from "@loreai/core";
import {
  installEmbeddedGatewaySigtermHandler,
  isLoopbackUrl,
  prepareLocalUiAssets,
  probeGateway,
} from "./internal";

const KNOWN_GATEWAY_PORTS = [3207, 5673];
let lastGatewayStartError: string | null = null;

export function gatewayStartError(): string | null {
  return lastGatewayStartError;
}

export async function resolveGatewayUrl(options?: {
  allowAmbient?: boolean;
  allowExplicit?: boolean;
}): Promise<string | null> {
  const allowAmbient = options?.allowAmbient ?? true;
  const allowExplicit = options?.allowExplicit ?? true;
  if (process.env.LORE_REMOTE_URL) {
    const url = process.env.LORE_REMOTE_URL.replace(/\/$/, "");
    if (await probeGateway(url)) return url;
    log.info(
      "remote gateway is not reachable, falling through to local discovery",
    );
  }
  let preparedLocalUi = false;
  if (allowExplicit && process.env.LORE_GATEWAY_URL) {
    const url = process.env.LORE_GATEWAY_URL.replace(/\/$/, "");
    if (isLoopbackUrl(url)) {
      await prepareLocalUiAssets();
      preparedLocalUi = true;
    }
    if (await probeGateway(url)) return url;
  }
  if (!allowAmbient) return null;
  if (!preparedLocalUi) await prepareLocalUiAssets();
  const probePorts = new Set<number>();
  try {
    const gw = "@loreai/gateway";
    const { readPortFile } = await import(/* webpackIgnore: true */ gw);
    const portfilePort = readPortFile();
    if (portfilePort) probePorts.add(portfilePort);
  } catch {
    // The gateway package may not be installed.
  }
  for (const port of KNOWN_GATEWAY_PORTS) probePorts.add(port);
  for (const port of probePorts) {
    const url = `http://127.0.0.1:${port}`;
    if (await probeGateway(url)) return url;
  }
  return null;
}

export async function startInProcess(): Promise<string | null> {
  try {
    const gw = "@loreai/gateway";
    const { startGateway } = await import(/* webpackIgnore: true */ gw);
    const handle = await startGateway({ quiet: true, local: true });
    const url = `http://127.0.0.1:${handle.port}`;
    if (handle.owned) installEmbeddedGatewaySigtermHandler(handle.shutdown);
    else log.info(`reusing existing gateway at ${url}`);
    return url;
  } catch (error) {
    lastGatewayStartError =
      error instanceof Error ? error.message : String(error);
    log.info("failed to start gateway in-process:", lastGatewayStartError);
    return null;
  }
}

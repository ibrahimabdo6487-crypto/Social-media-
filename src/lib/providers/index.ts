import type { ProviderId } from "../models";
import type { ProviderAdapter } from "./types";
import { kie } from "./kie";
import { cometapi } from "./cometapi";
export const PROVIDERS: Record<ProviderId, ProviderAdapter> = { kie, cometapi };

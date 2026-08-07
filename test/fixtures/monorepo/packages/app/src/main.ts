import { coreValue, type CoreResult } from "@mono/core";

export function appMain(): CoreResult {
  return { value: coreValue() };
}

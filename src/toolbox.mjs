import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function parseToolboxSpec(spec) {
  const separator = spec.lastIndexOf(':');
  if (separator < 1 || separator === spec.length - 1) throw new TypeError('toolbox must use MODULE:ALIAS');
  return { modulePath: resolve(spec.slice(0, separator)), alias: spec.slice(separator + 1) };
}

export async function loadToolbox(spec) {
  const { modulePath, alias } = parseToolboxSpec(spec);
  const module = await import(pathToFileURL(modulePath).href);
  const tools = module.toolbox ?? module.tools ?? module.default;
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new TypeError(`toolbox module ${modulePath} must export toolbox or tools`);
  }
  return { alias, tools };
}

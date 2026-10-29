import { demoConnector } from './demo.js';
import { googleConnector } from './google.js';
import { microsoftConnector } from './microsoft.js';
import { slackConnector } from './slack.js';
import { todoistConnector } from './todoist.js';
import type { Connector, ProviderId } from './types.js';

export * from './types.js';
export { pkcePair, request, parseAddress, parseAddressList, htmlToText, stripQuoted } from './http.js';
export { buildRfc822 } from './google.js';
export { generateDemoData } from './demo.js';
export { mapTodoistTask } from './todoist.js';
export { demoConnector, googleConnector, microsoftConnector, slackConnector, todoistConnector };

export const CONNECTORS: Record<ProviderId, Connector> = {
  google: googleConnector,
  microsoft: microsoftConnector,
  slack: slackConnector,
  todoist: todoistConnector,
  demo: demoConnector,
};

export function getConnector(p: string): Connector | undefined {
  return (CONNECTORS as Record<string, Connector>)[p];
}

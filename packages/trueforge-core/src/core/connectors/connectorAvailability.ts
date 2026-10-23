/** Where a connector stands for one chat. `unknown` when the list of set-up connectors could not be read. */
export type ConnectorAvailability = 'in-chat' | 'turned-off' | 'not-set-up' | 'unknown';

function turnOnSteps(connector: string): string {
  return `To turn it on, the person opens Add-ons in the composer, goes to Connectors, and turns on ${connector}.`;
}

const SET_UP_PLACE = 'Settings, Connectors';

/** One plain line on why a connector cannot be used here, and the one thing to do next. */
export function connectorUnavailableLine({
  connector,
  availability,
}: {
  connector: string;
  availability: ConnectorAvailability;
}): string {
  switch (availability) {
    case 'in-chat':
      return `The connector is named '${connector}' in this chat; use that exact name.`;
    case 'turned-off':
      return `The ${connector} connector is set up but turned off for this chat. ${turnOnSteps(connector)}`;
    case 'not-set-up':
      return `No connector named '${connector}' is set up. The person can set one up in ${SET_UP_PLACE}.`;
    case 'unknown':
      return `The ${connector} connector is not on for this chat. ${turnOnSteps(connector)} If it is not listed there, the person can set it up in ${SET_UP_PLACE}.`;
  }
}

/**
 * What the Settings Email and Calendar endpoints do once a request is accepted, the same for both. The router
 * of each kind only maps these answers onto its routes. Browser session only (mounted behind the UI-session
 * middleware) and admin only, so no agent or API token and no member can read or change the account. The app
 * password passes through the save call to the sidecar's account agent and is never stored here, never logged
 * and never returned; responses are built only from the account's public view.
 */
import { ConnectorAccountError, type ConnectorAccountState } from '../runtime/connectorAccount';

interface ErrorBody {
  error: { message: string; type: string };
}

/** What a handler answers with; each router returns only the statuses its routes declare. */
export type ReadAnswer<TStatus> = { status: 200; body: { data: TStatus } } | { status: 502; body: ErrorBody };
export type SaveAnswer<TStatus> = { status: 201; body: { data: TStatus } } | { status: 400 | 502; body: ErrorBody };

export interface ConnectorAccountHandlerKind<TAccount, TRequest, TStatus> {
  /** False when the instance has no connector of this kind to configure, so no card is shown. */
  isAvailable(): boolean;
  unavailableBody(): TStatus;
  statusBody(state: ConnectorAccountState<TAccount>): TStatus;
  readState(): Promise<ConnectorAccountState<TAccount>>;
  save(request: TRequest): Promise<ConnectorAccountState<TAccount>>;
  remove(): Promise<ConnectorAccountState<TAccount>>;
  /** Brings the connector's registration in line with the agent's answer; never throws. */
  sync(state: ConnectorAccountState<TAccount>): Promise<void>;
}

function errorBody(caught: ConnectorAccountError): ErrorBody {
  return { error: { message: caught.message, type: caught.failure } };
}

export function createConnectorAccountHandlers<TAccount, TRequest, TStatus>(
  kind: ConnectorAccountHandlerKind<TAccount, TRequest, TStatus>,
) {
  /**
   * A call that could not reach the agent may still have changed the account, such as a save that took longer
   * than the wait. The registration follows what the agent really holds, so it is asked again and synced.
   */
  async function reconcileAfterUnreachable(caught: ConnectorAccountError): Promise<void> {
    if (caught.failure !== 'connector_unreachable') {
      return;
    }
    try {
      await kind.sync(await kind.readState());
    } catch {
      // Still unreachable: the next status read or boot settles it.
    }
  }

  return {
    async status(): Promise<ReadAnswer<TStatus>> {
      if (!kind.isAvailable()) {
        return { status: 200, body: { data: kind.unavailableBody() } };
      }
      try {
        const state = await kind.readState();
        // Every status read settles the registration, so a save that was cut off still ends up attached.
        await kind.sync(state);
        return { status: 200, body: { data: kind.statusBody(state) } };
      } catch (caught) {
        if (caught instanceof ConnectorAccountError) {
          // A status read can only fail one way: the connector could not be reached.
          return { status: 502, body: errorBody(caught) };
        }
        throw caught;
      }
    },

    async save(request: TRequest): Promise<SaveAnswer<TStatus>> {
      try {
        const state = await kind.save(request);
        await kind.sync(state);
        return { status: 201, body: { data: kind.statusBody(state) } };
      } catch (caught) {
        if (caught instanceof ConnectorAccountError) {
          await reconcileAfterUnreachable(caught);
          return { status: caught.failure === 'connector_unreachable' ? 502 : 400, body: errorBody(caught) };
        }
        throw caught;
      }
    },

    async remove(): Promise<ReadAnswer<TStatus>> {
      try {
        const state = await kind.remove();
        await kind.sync(state);
        return { status: 200, body: { data: kind.statusBody(state) } };
      } catch (caught) {
        if (caught instanceof ConnectorAccountError) {
          await reconcileAfterUnreachable(caught);
          // A removal can only fail one way: the connector could not be reached.
          return { status: 502, body: errorBody(caught) };
        }
        throw caught;
      }
    },
  };
}

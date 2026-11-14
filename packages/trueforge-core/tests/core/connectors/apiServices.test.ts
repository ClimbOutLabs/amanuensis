import {
  API_SERVICE_DECLARATIONS,
  apiServiceDeclarationForHost,
  apiServiceHostsCanSend,
  type ApiServiceDeclaration,
} from '../../../src/core/connectors/apiServices';

/**
 * Invented services that exist nowhere else in the codebase. They stand in for the next service
 * Aman learns about: the behaviour has to come from the declaration alone, never from the name.
 */
const INVENTED_SEND_SERVICE: ApiServiceDeclaration = {
  service: 'Parchment Post',
  hosts: ['api.parchment-post.example'],
  can_send: true,
};

const INVENTED_READ_SERVICE: ApiServiceDeclaration = {
  service: 'Ledger Look',
  hosts: ['api.ledger-look.example'],
  can_send: false,
};

const INVENTED_DECLARATIONS: readonly ApiServiceDeclaration[] = [INVENTED_SEND_SERVICE, INVENTED_READ_SERVICE];

describe('apiServiceHostsCanSend', () => {
  it('is true for a host whose owner declares it can send, however new the service is', () => {
    expect(apiServiceHostsCanSend({ hosts: ['api.parchment-post.example'], declarations: INVENTED_DECLARATIONS })).toBe(
      true,
    );
    expect(
      apiServiceHostsCanSend({
        hosts: ['example.com', 'api.parchment-post.example'],
        declarations: INVENTED_DECLARATIONS,
      }),
    ).toBe(true);
  });

  it('is false for a host whose owner declares it cannot send', () => {
    expect(apiServiceHostsCanSend({ hosts: ['api.ledger-look.example'], declarations: INVENTED_DECLARATIONS })).toBe(
      false,
    );
  });

  it('is false for a host no service declares, and for no hosts at all', () => {
    expect(apiServiceHostsCanSend({ hosts: ['undeclared.example'], declarations: INVENTED_DECLARATIONS })).toBe(false);
    expect(apiServiceHostsCanSend({ hosts: [], declarations: INVENTED_DECLARATIONS })).toBe(false);
  });

  it('keeps the warning for the shipped mail and calendar services', () => {
    for (const host of ['gmail.googleapis.com', 'www.googleapis.com', 'graph.microsoft.com', 'outlook.office365.com']) {
      expect(apiServiceHostsCanSend({ hosts: [host], declarations: API_SERVICE_DECLARATIONS })).toBe(true);
    }
  });

  it('is false for shipped hosts no service declares as send-capable', () => {
    expect(
      apiServiceHostsCanSend({ hosts: ['github.com', 'api.github.com'], declarations: API_SERVICE_DECLARATIONS }),
    ).toBe(false);
  });
});

describe('apiServiceDeclarationForHost', () => {
  it('returns the owning service declaration for a declared host', () => {
    expect(
      apiServiceDeclarationForHost({ host: 'api.parchment-post.example', declarations: INVENTED_DECLARATIONS }),
    ).toEqual(INVENTED_SEND_SERVICE);
  });

  it('returns undefined for a host no service declares', () => {
    expect(apiServiceDeclarationForHost({ host: 'undeclared.example', declarations: INVENTED_DECLARATIONS })).toBe(
      undefined,
    );
  });
});

import {
  API_SERVICE_DECLARATIONS,
  apiServiceDeclarationForHost,
  apiServiceHostsCanSend,
  isSkillBlockedHost,
  type ApiServiceDeclaration,
} from '../../../src/core/connectors/apiServices';

/**
 * Invented services that exist nowhere else in the codebase. They stand in for the next service
 * Aman learns about: the behaviour has to come from the declaration alone, never from the name.
 */
const INVENTED_SEND_SERVICE: ApiServiceDeclaration = {
  service: 'Parchment Post',
  hosts: ['api.parchment-post.example'],
  host_patterns: [],
  can_send: true,
};

const INVENTED_READ_SERVICE: ApiServiceDeclaration = {
  service: 'Ledger Look',
  hosts: ['api.ledger-look.example'],
  host_patterns: [],
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

describe('isSkillBlockedHost', () => {
  it('blocks the mail, email-sending and forwarding services Aman knows, however the name is written', () => {
    for (const host of [
      'gmail.googleapis.com',
      'GRAPH.microsoft.com',
      'api.sendgrid.com.',
      'api.eu.mailgun.net',
      'email.eu-west-1.amazonaws.com',
      'mail.zoho.eu',
      'hooks.zapier.com',
      'hook.eu1.make.com',
      'abc123.m.pipedream.net',
    ]) {
      expect(isSkillBlockedHost(host)).toBe(true);
    }
  });

  it('leaves other sites alone, including neighbours of a blocked one', () => {
    for (const host of ['api.github.com', 's3.amazonaws.com', 'zapier.com', 'notmail.zoho.com.example', 'make.com']) {
      expect(isSkillBlockedHost(host)).toBe(false);
    }
  });
});

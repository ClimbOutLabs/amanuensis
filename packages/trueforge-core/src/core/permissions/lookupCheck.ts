/**
 * The checks a designated web lookup's text must pass before it runs without asking: the outbound
 * secret guard over the text, whether a link the text names may go, and whether the text carries one of
 * the person's own details once the chat has read other content. The classifier and the space link check
 * both use it, so a link is judged the same way whether a lookup or a space picture asks for it. How a
 * link is used decides the link test: a lookup the assistant runs once may follow a link read content
 * named, while an embed is loaded by the person's own browser every time it is shown, so only a link
 * the person, a search, or a page the chat opened chose may be one.
 */
import { checkOutboundStrings, type OutboundGuardVerdict, type OutboundStrings } from './outboundGuard';
import { carriedPrivateDetails, hasReadContent, steeredLinks, unchosenLinks, type ChatProvenance } from './provenance';

/** How the checked text reaches its links: a lookup the assistant runs once, or an embed a browser loads. */
export type LookupUse = 'lookup' | 'embed';

export interface LookupCheck {
  verdict: OutboundGuardVerdict;
  /**
   * Links the text names that may not go under the use given: ones only read content put there for a
   * lookup, ones nobody chose for an embed. Empty when every link may go.
   */
  steered: string[];
  /**
   * The person's own details the text carries, once the chat has read other content: the private_detail
   * outcome. Empty when the chat has read nothing, or the text carries none of them.
   */
  privateDetails: string[];
}

export function checkLookup(input: {
  strings: OutboundStrings | undefined;
  secrets: readonly string[];
  earlier: string | undefined;
  provenance: ChatProvenance;
  use: LookupUse;
}): LookupCheck {
  const { strings } = input;
  if (strings === undefined) {
    return { verdict: { ok: false, rule: 'uninspectable' }, steered: [], privateDetails: [] };
  }
  const values = [...strings.values, ...strings.plumbing];
  return {
    verdict: checkOutboundStrings({ strings, secrets: input.secrets, earlier: input.earlier }),
    steered:
      input.use === 'embed'
        ? unchosenLinks({ provenance: input.provenance, values })
        : steeredLinks({ provenance: input.provenance, values }),
    privateDetails: hasReadContent(input.provenance)
      ? carriedPrivateDetails({ provenance: input.provenance, values })
      : [],
  };
}

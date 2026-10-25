/**
 * The two checks a designated web lookup's text must pass before it runs without asking: the outbound
 * secret guard over the text, and whether read content chose a link the lookup names. The classifier and
 * the space link check both use it, so a link is judged the same way whether a lookup or a space picture asks for it.
 */
import { checkOutboundStrings, type OutboundGuardVerdict, type OutboundStrings } from './outboundGuard';
import { steeredLinks, type ChatProvenance } from './provenance';

export interface LookupCheck {
  verdict: OutboundGuardVerdict;
  /** Links the lookup names that only read content put there; empty when the person chose them all. */
  steered: string[];
}

export function checkLookup(input: {
  strings: OutboundStrings | undefined;
  secrets: readonly string[];
  earlier: string | undefined;
  provenance: ChatProvenance;
}): LookupCheck {
  const { strings } = input;
  if (strings === undefined) {
    return { verdict: { ok: false, rule: 'uninspectable' }, steered: [] };
  }
  return {
    verdict: checkOutboundStrings({ strings, secrets: input.secrets, earlier: input.earlier }),
    steered: steeredLinks({ provenance: input.provenance, values: [...strings.values, ...strings.plumbing] }),
  };
}

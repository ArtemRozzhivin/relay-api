import ipaddr from 'ipaddr.js';

// The only IPv6 block handed out for public use. ipaddr.js names most of what
// lies outside it, but not all: `::7f00:1`, the deprecated IPv4-compatible
// form of 127.0.0.1, reads to it as plain unicast.
const GLOBAL_UNICAST_V6 = ipaddr.parseCIDR('2000::/3');

/**
 * Whether the worker may connect to an address on a seller's behalf: only a
 * public unicast one.
 *
 * An allow-list, not a list of private ranges to refuse: every range that is
 * not plain public unicast — loopback, private, link-local and the cloud
 * metadata service on it, carrier-grade NAT, and the IPv6 forms that carry an
 * IPv4 address inside them (mapped, compatible, NAT64, 6to4, Teredo) — is
 * refused without anyone having to remember it. An IPv6 address must also be
 * in `2000::/3`, the block public addresses are given from.
 */
export const isPublicAddress = (address: string) => {
  if (!ipaddr.isValid(address)) {
    return false;
  }

  const parsed = ipaddr.process(address);

  return (
    parsed.range() === 'unicast' &&
    (parsed.kind() === 'ipv4' || parsed.match(GLOBAL_UNICAST_V6))
  );
};

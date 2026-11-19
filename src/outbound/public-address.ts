import ipaddr from 'ipaddr.js';

/**
 * Whether the worker may connect to an address on a seller's behalf: only a
 * public unicast one.
 *
 * An allow-list, not a list of private ranges to refuse: every range that is
 * not plain public unicast — loopback, private, link-local and the cloud
 * metadata service on it, carrier-grade NAT, and the IPv6 forms that carry an
 * IPv4 address inside them (mapped, NAT64, 6to4, Teredo) — is refused without
 * anyone having to remember it.
 */
export const isPublicAddress = (address: string) =>
  ipaddr.isValid(address) && ipaddr.process(address).range() === 'unicast';

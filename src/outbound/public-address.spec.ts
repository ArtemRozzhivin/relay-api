import { describe, expect, it } from 'vitest';
import { isPublicAddress } from './public-address.js';

describe('isPublicAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.169.254', 'link-local: the cloud metadata service'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['0.0.0.0', 'unspecified, which connects to this host'],
    ['255.255.255.255', 'broadcast'],
    ['224.0.0.1', 'multicast'],
    ['::1', 'IPv6 loopback'],
    ['fe80::1', 'IPv6 link-local'],
    ['fd12::1', 'IPv6 unique-local'],
    ['::ffff:127.0.0.1', 'IPv4 loopback inside an IPv6 address'],
    ['::ffff:169.254.169.254', 'the metadata service inside an IPv6 address'],
    ['64:ff9b::7f00:1', 'NAT64 of 127.0.0.1'],
    ['2002:7f00:1::', '6to4 of 127.0.0.1'],
    ['not-an-address', 'not an address at all'],
  ])('refuses %s (%s)', (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each(['8.8.8.8', '52.219.170.1', '2606:4700:4700::1111'])(
    'allows %s, a public address',
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );
});

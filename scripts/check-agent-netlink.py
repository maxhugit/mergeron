"""Run inside the agent command sandbox. No network/configuration is changed."""
import errno
import socket
import struct

with open('/proc/self/status', encoding='utf-8') as source:
    fields = dict(line.strip().split(':', 1) for line in source if ':' in line)
assert int(fields['CapEff'].strip(), 16) == 0
assert int(fields['CapPrm'].strip(), 16) == 0
assert fields['NoNewPrivs'].strip() == '1'
assert fields['Seccomp'].strip() == '2'

for family, kind, protocol in [
    (socket.AF_UNIX, socket.SOCK_STREAM, 0),
    (socket.AF_NETLINK, socket.SOCK_RAW, 2),  # NETLINK_USERSOCK
    (socket.AF_NETLINK, socket.SOCK_RAW, 4),  # NETLINK_SOCK_DIAG
    (socket.AF_NETLINK, socket.SOCK_RAW, 16),  # NETLINK_GENERIC
    (socket.AF_NETLINK, socket.SOCK_DGRAM, socket.NETLINK_ROUTE),
    (socket.AF_PACKET, socket.SOCK_RAW, 0),
    (getattr(socket, 'AF_VSOCK', 40), socket.SOCK_STREAM, 0),
]:
    try:
        unexpected = socket.socket(family, kind, protocol)
    except OSError as error:
        assert error.errno == errno.EPERM, (family, kind, protocol, error.errno)
    else:
        unexpected.close()
        raise AssertionError(('unexpected socket grant', family, kind, protocol))

with socket.socket(socket.AF_NETLINK, socket.SOCK_RAW, socket.NETLINK_ROUTE) as route:
    route.settimeout(2)
    route.bind((0, 0))
    # RTM_NEWLINK with zero change mask and no attributes is deliberately a
    # no-op, even if mistakenly authorized. The kernel must still require
    # CAP_NET_ADMIN and reply EPERM before applying any request.
    payload = struct.pack('BxHiII', socket.AF_UNSPEC, 0, 1, 0, 0)
    request = struct.pack('IHHII', 16 + len(payload), 16, 1 | 4, 913, 0) + payload
    route.sendto(request, (0, 0))
    reply = route.recv(4096)
    assert len(reply) >= 20
    _, message_type, _, sequence, _ = struct.unpack_from('IHHII', reply)
    assert message_type == 2 and sequence == 913  # NLMSG_ERROR
    assert struct.unpack_from('i', reply, 16)[0] == -errno.EPERM

print('PASS: NETLINK_ROUTE query socket allowed; other families/protocols and privileged link operations denied; capabilities zero')

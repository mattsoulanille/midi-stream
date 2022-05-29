import * as udp from 'dgram';
import * as midi from 'midi';
import {ArgumentParser} from 'argparse';
import * as net from 'net';
import { Stream } from 'stream';
import * as t from 'io-ts';
import { isRight } from 'fp-ts/lib/Either';

const LocalMessage = t.type({
  midiMessage: t.tuple([t.number, t.number, t.number]),
  time: t.number,
});
type LocalMessage = t.TypeOf<typeof LocalMessage>;

const Message = new t.Type(
  'Message',
  LocalMessage.is,
  (i: Buffer, context) => {
    if (i.length !== 9) {
      return t.failure(i, context);
    }
    const dv = new DataView(i.buffer);
    return t.success({
      midiMessage: [i[0], i[1], i[2]] as [number, number, number],
      time: dv.getFloat64(3),
    });
  },
  a => {
    const buf = Buffer.alloc(9);
    buf.set(a.midiMessage, 0);
    const dv = new DataView(buf.buffer);
    dv.setFloat64(3, a.time);
    return buf;
  }
);
type Message = t.TypeOf<typeof Message>;

const PORT = 2222;

function makeTcpServer() {
  const server = net.createServer();
  const clients = new Set<net.Socket>();
  server.on('connection', socket => {
    clients.add(socket);
    socket.on('close', () => {
      clients.delete(socket);
    });
  });

  server.listen(PORT);

  return (message: Message) => {
    console.log(clients);
    for (const socket of clients) {
      socket.write(Message.encode(message));
    }
  }
}

function makeTcpClient(ip: string, cb: (m: Message) => void) {
  const client = new net.Socket();
  client.connect({port: PORT, host: ip});
  client.on('data', data => {
    const maybeMessage = Message.decode(data);
    if (isRight(maybeMessage)) {
      cb(maybeMessage.right);
    } else {
      console.warn(maybeMessage.left);
    }
  });
}

const UDP_TIMEOUT = 30_000;

function makeUdpServer() {
  const server = udp.createSocket('udp4');
  const clients = new Map<string, {
    port: number,
    timeout: NodeJS.Timeout,
  }>();

  function makeTimeout(address: string) {
    return setTimeout(() => {
      console.log(`Removing client ${address}`);
      clients.delete(address);
    }, UDP_TIMEOUT);
  }

  server.on('message', (msg: Buffer, info) => {
    if (msg.toString('utf8') === 'subscribe') {
      if (clients.has(info.address)) {
        const entry = clients.get(info.address)!;
        clearTimeout(entry.timeout);
        entry.timeout = makeTimeout(info.address);
      } else {
        clients.set(info.address, {
          port: info.port,
          timeout: makeTimeout(info.address),
        });
      }
      console.log(clients.keys());
    }
  });

  server.bind({port: PORT});
  return (message: Message) => {
    for (const [address, {port}] of clients) {
      console.log(message);
      server.send(Message.encode(message), port, address);
    }
  }
}

function makeUdpClient(ip: string, cb: (m: Message) => void) {
  function connect() {
    const client = udp.createSocket('udp4');

    function keepalive() {
      client.send(Buffer.from('subscribe'), PORT, ip, err => {
        if (err) {
          client.close();
          console.warn(err);
          clearInterval(connectionInterval);
          connect(); // Reconnect
        }
      });
    }

    const connectionInterval = setInterval(keepalive, UDP_TIMEOUT / 8);
    client.on('message', (msg, info) => {
      const maybeMessage = Message.decode(msg);
      if (info.address !== ip) {
        console.warn(`Ignoring message from ${info.address}`);
        return;
      }
      if (isRight(maybeMessage)) {
        cb(maybeMessage.right);
      } else {
        console.warn(maybeMessage.left);
      }
    });
    keepalive();
  }
  connect();
}

type Protocol = 'tcp' | 'udp';
function server() {
  const input = new midi.Input();
  let port;
  let search = 'Piano';
  for (let i = 0; i < input.getPortCount(); i++) {
    if (input.getPortName(i).includes(search)) {
      port = i;
    }
  }

  if (port === undefined) {
    throw new Error(`No midi device with ${search} in its name found`);
  }

  const udp = makeUdpServer();
  const tcp = makeTcpServer();
  const send = (m: Message) => {
    udp(m);
    tcp(m);
  }

  let time = 0;
  input.on('message', (deltaTime, midiMessage) => {
    time += deltaTime;
    send({time , midiMessage});
  });
  input.openPort(port);
  console.log(`Serving ${input.getPortName(port)}`);
}

class BufferedMidi {
  private timeOffset: number | undefined;
  constructor(readonly play: (m: midi.MidiMessage) => void,
              public buffer_ms: number) {}
  insert(m: Message) {
    if (this.timeOffset == null) {
      this.timeOffset = m.time - performance.now();
    }

    const playTime = m.time - this.timeOffset + this.buffer_ms;
    setTimeout(() => this.play(m.midiMessage),
               playTime - performance.now());
  }
}

function client(serverAddress: string, protocol: Protocol, bufferMs: number) {
  // creating a client socket
  console.log(`Connecting to ${serverAddress}`);
  const output = new midi.Output();
  output.openVirtualPort('Pi Piano');

  const buf = new BufferedMidi(midi => output.sendMessage(midi), bufferMs);
  const insert = (m: Message) => buf.insert(m);

  if (protocol === 'udp') {
    makeUdpClient(serverAddress, insert);
  } else {
    makeTcpClient(serverAddress, insert);
  }
}

if (require.main === module) {
  const parser = new ArgumentParser({
    description: 'Send midi over the web',
  });

  parser.add_argument('server_address', {
    type: String,
    nargs: '?',
    default: ''
  });
  parser.add_argument('--protocol', '-p', {
    type: String,
    choices: ['tcp', 'udp'],
    default: 'udp',
  });
  parser.add_argument('--buffer', '-b', {
    type: Number,
    default: 0,
    help: 'Buffer for notes in milliseconds'
  });

  const args = parser.parse_args();
  if (args.server_address) {
    client(args.server_address, args.protocol, args.buffer);
  }
  else {
    server();
  }
}


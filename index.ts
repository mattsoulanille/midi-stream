import * as udp from 'dgram';
import * as midi from 'midi';
import {ArgumentParser} from 'argparse';
import * as net from 'net';
import * as t from 'io-ts';
import {isRight} from 'fp-ts/lib/Either';
import {performance} from 'perf_hooks';

const LocalMessage = t.type({
  midiMessage: t.tuple([t.number, t.number, t.number]),
  time: t.number,
});
type LocalMessage = t.TypeOf<typeof LocalMessage>;

// [uint8, uint8, uint8, float64]
const BUF_SIZE = 3 + 8;
const Message = new t.Type(
  'Message',
  LocalMessage.is,
  (i: Buffer, context) => {
    if (i.length !== BUF_SIZE) {
      return t.failure(i, context);
    }
    const dv = new DataView(i.buffer);
    return t.success({
      midiMessage: [i[0], i[1], i[2]] as [number, number, number],
      time: dv.getFloat64(3),
    });
  },
  a => {
    const buf = Buffer.alloc(BUF_SIZE);
    buf.set(a.midiMessage, 0);
    const dv = new DataView(buf.buffer);
    dv.setFloat64(3, a.time);
    return buf;
  }
);
type Message = t.TypeOf<typeof Message>;

class MessageStream {
  constructor(public cb: (message: Message) => void) {}

  insert(data: Buffer) {
    if (data.length % BUF_SIZE !== 0) {
      console.warn(`Got data of length ${data.length} !%= ${BUF_SIZE}`, data);
      return;
    }

    for (let i = 0; i < data.length / BUF_SIZE; i++) {
      const sliced = data.slice(i * BUF_SIZE, (i + 1) * BUF_SIZE);
      const maybeMessage = Message.decode(sliced);
      if (isRight(maybeMessage)) {
        this.cb(maybeMessage.right);
      } else {
        console.warn('Failed to decode message', maybeMessage.left);
      }
    }
  }
}

const PORT = 25114;

function makeTcpServer() {
  const server = net.createServer();
  const clients = new Set<net.Socket>();
  server.on('connection', socket => {
    clients.add(socket);
    console.log([...clients].map(c => c.address()));
    socket.on('error', err => {
      console.log(err);
    });
    socket.on('close', () => {
      clients.delete(socket);
      console.log([...clients].map(c => c.address()));
    });
  });

  server.listen(PORT);

  return [(message: Message) => {
    for (const socket of clients) {
      socket.write(Message.encode(message));
    }
  }, clients] as const;
}

function makeTcpClient(ip: string, cb: (m: Message) => void) {
  function connect() {
    const client = new net.Socket();

    client.connect({port: PORT, host: ip});
    const messageStream = new MessageStream(cb);
    client.on('data', data => {
      messageStream.insert(data);
    });
    client.on('close', () => {
      setTimeout(connect, 5000);
    });
    client.on('error', err => {
      console.warn(err);
      // No need to call connect() here since the 'close' event is also emitted.
    });
  }
  connect();
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
      clients.delete(address);
      console.log([...clients.keys()]);
    }, UDP_TIMEOUT);
  }

  server.on('message', (msg: Buffer, info) => {
    if (msg.equals(Buffer.from('subscribe'))) {
      if (clients.has(info.address)) {
        const entry = clients.get(info.address)!;
        clearTimeout(entry.timeout);
        entry.timeout = makeTimeout(info.address);
        entry.port = info.port;
      } else {
        clients.set(info.address, {
          port: info.port,
          timeout: makeTimeout(info.address),
        });
        console.log([...clients.keys()]);
      }
    }
  });

  server.bind({port: PORT});
  return [(message: Message) => {
    for (const [address, {port}] of clients) {
      server.send(Message.encode(message), port, address);
    }
  }, clients] as const;
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
    const messageStream = new MessageStream(cb);
    client.on('message', (msg, info) => {
      messageStream.insert(msg);
    });
    keepalive();
  }
  connect();
}

function getPort(midiInterface: midi.Input | midi.Output, portName: string) {
  for (let i = 0; i < midiInterface.getPortCount(); i++) {
    if (midiInterface.getPortName(i).includes(portName)) {
      return i;
    }
  }
  return undefined;
}

function getInput(inputName: string): midi.Input {
  const input = new midi.Input();
  const port = getPort(input, inputName);
  if (port === undefined) {
    throw new Error(`No midi device with ${inputName} in its name found`);
  }

  input.openPort(port);
  return input;
}

type Protocol = 'tcp' | 'udp';
function server(inputName: string) {
  let input = new midi.Input();
  const activeNotes = new Set<number>();
  const [sendUdp, udpClients] = makeUdpServer();
  const [sendTcp, tcpClients] = makeTcpServer();
  const send = (m: Message) => {
    sendUdp(m);
    sendTcp(m);
  }

  let time: number;
  function setupInput(input: midi.Input) {
    let firstInput = true;
    input.on('message', (deltaTime, midiMessage) => {
      // Use the device's delta, which is more accurate, execpt for the first
      // message from the device.
      if (firstInput) {
        time = new Date().getTime();
      } else {
        time += deltaTime * 1000;
      }

      // Track what notes are on, so they can be turned off when the device
      // disconnects.
      if (midiMessage[2]) {
        activeNotes.add(midiMessage[1]);
      } else {
        activeNotes.delete(midiMessage[1]);
      }

      send({time, midiMessage});
    });
  }

  let portOpen = false;

  // There's no event for a device disconnecting, so use polling.
  setInterval(() => {
    const hasPort = getPort(input, inputName) !== undefined;
    if (!hasPort && portOpen) {
      console.log('closing port');
      portOpen = false;
      input.closePort();
      for (const note of activeNotes) {
        send({time, midiMessage: [144, note, 0]});
      }
    }
    if (hasPort && !portOpen) {
      console.log('opening port');
      try {
        input = getInput(inputName);
        setupInput(input);
        portOpen = true;
      } catch (e) {
        if (!(e instanceof Error && e.message.includes('No midi device'))) {
          console.warn(e);
        }
      }
    }
  }, 50);

  // Respond to requests for the number of clients
  const clientsCountServer = udp.createSocket('udp4');
  clientsCountServer.bind({port: PORT + 1})
  clientsCountServer.on('message', (msg: Buffer, info) => {
    if (msg.equals(Buffer.from('clients'))) {
      const buf = Buffer.from(
        new Uint32Array([udpClients.size + tcpClients.size]).buffer);
      clientsCountServer.send(buf, info.port, info.address);
    }
  });
}

class BufferedMidi {
  private timeOffset: number | undefined;
  constructor(readonly play: (m: midi.MidiMessage) => void,
              public buffer_ms: number) {}
  insert(m: Message) {
    if (this.buffer_ms === 0) {
      this.play(m.midiMessage);
      return;
    }
    if (this.timeOffset == null) {
      this.timeOffset = m.time - performance.now();
    }

    const playTime = m.time - this.timeOffset + this.buffer_ms;
    setTimeout(() => this.play(m.midiMessage),
               playTime - performance.now());
  }
}

function stuckNoteFixer(play: (m: midi.MidiMessage) => void) {
  const notes = new Map<number /* note */, NodeJS.Timeout>();
  return (m: midi.MidiMessage) => {
    if (m[0] === 144) {
      const note = m[1];
      if (notes.has(note)) {
        play([144, m[1], 0]);
        clearTimeout(notes.get(note));
        notes.delete(note);
      }
      if (m[2] !== 0) {
        notes.set(note, setTimeout(() => {
          play([144, m[1], 0]);
        }, 30_000));
      }
    }
    play(m);
  }
}

function client(serverAddress: string, protocol: Protocol, bufferMs: number,
                outputName?: string) {
  // creating a client socket
  console.log(`Connecting to ${serverAddress}`);
  const output = new midi.Output();
  let port: number | undefined;
  if (outputName) {
    port = getPort(output, outputName);
  }

  if (port != undefined) {
    console.log(`Using real port ${output.getPortName(port)}`);
    output.openPort(port);
  } else {
    const virtualPort = 'Remote Piano';
    console.log(`Using virtual port ${virtualPort}`);
    output.openVirtualPort(virtualPort);
  }
  function play(midi: midi.MidiMessage) {
    output.sendMessage(midi);
  }
  const buf = new BufferedMidi(stuckNoteFixer(play), bufferMs);
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
  parser.add_argument('--input', '-i', {
    type: String,
    nargs: '?',
    default: 'Piano',
    help: 'The midi input to serve',
  });
  parser.add_argument('--output', '-o', {
    type: String,
    default: 'Piano',
    help: 'The midi output to use. Defaults to synthetic output.',
  });
  parser.add_argument('--protocol', '-p', {
    type: String,
    choices: ['tcp', 'udp'],
    default: 'tcp',
  });
  parser.add_argument('--buffer', '-b', {
    type: Number,
    default: 5000,
    help: 'Buffer for notes in milliseconds'
  });

  const args = parser.parse_args();
  if (args.server_address) {
    client(args.server_address, args.protocol, args.buffer, args.output);
  }
  else {
    server(args.input);
  }
}

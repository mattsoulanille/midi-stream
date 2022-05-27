const udp = require('dgram');
const buffer = require('buffer');
const midi = require('midi');
const { ArgumentParser } = require('argparse');

const PORT = 2222;

function server() {
  const server = udp.createSocket('udp4');
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
  
  const clients = new Map();

  server.on('message', (msg, info) => {
    if (msg = 'subscribe') {
      console.log(`Subscribing ${info.address}:${info.port}`);
      clients.set(info.address, info.port);
    }
  });

  server.bind({port: PORT});

  input.on('message', (deltaTime, message) => {
    console.log(message);
    for (const [address, port] of clients) {
      server.send(JSON.stringify({
        message,
        deltaTime,
      }), port, address);
    }
  });

  input.openPort(port);
  console.log(`Serving ${input.getPortName(port)}`);
}

function client(serverAddress) {
  // creating a client socket
  console.log(`Connecting to ${serverAddress}`);
  const client = udp.createSocket('udp4');
  const output = new midi.Output();
  output.openVirtualPort('Pi Piano');

  client.on('message', (msg, info) => {
    console.log('Data received from server : ' + msg.toString());
    console.log('Received %d bytes from %s:%d\n', msg.length, info.address, info.port);
    const decoded = JSON.parse(msg.toString());
    output.sendMessage(decoded.message);
  });

  const data = Buffer.from('subscribe');

  client.send(data, PORT, serverAddress, function(error){
    if (error){
      client.close();
    } else {
      console.log(`Sent subscription request to ${serverAddress}`);
    }
  });
}

if (require.main === module) {
  const parser = new ArgumentParser({
    description: 'Send midi over the web',
  });

  parser.add_argument('server_address', {type: 'str', nargs: '?', default: ''});

  const args = parser.parse_args();
  if (args.server_address) {
    client(args.server_address);
  }
  else {
    server();
  }
}


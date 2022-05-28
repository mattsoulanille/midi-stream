import * as EventEmitter from "events";
import { Stream } from "stream";

declare module 'midi' {
  export class Input extends EventEmitter {
    closePort(): void;
    getPortCount(): number;
    getPortName(port: number): string;
    ignoreTypes(sysex: boolean, timing: boolean, activeSensing: boolean): void;
    isPortOpen(): boolean;
    openPort(port: number): void;
    openVirtualPort(port: string): void;
  }

  export class Output {
    closePort(): void;
    getPortCount(): number;
    getPortName(port: number): string;
    isPortOpen(): boolean;
    openPort(port: number): void;
    openVirtualPort(port: string): void;
    send(message: [number, ...number[]]): void;
    sendMessage(message: [number, ...number[]]): void;
  }

  export const input: {new(): Input};
  export const output: {new(): Output};

  export function createReadStream(input?: Input): Stream;

  export function createWriteStream(output?: Output): Stream;
}

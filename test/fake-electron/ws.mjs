// The keeper WebSocket, faked: the test plays the service — it opens the socket, sends
// frames in (`deliver`) and reads what the Keeper sent (`sent`).
import { EventEmitter } from "node:events";

export const sockets = [];

export class WebSocket extends EventEmitter {
  static OPEN = 1;
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.readyState = 0;
    this.sent = [];
    sockets.push(this);
  }
  open() { this.readyState = WebSocket.OPEN; this.emit("open"); }
  deliver(obj) { this.emit("message", Buffer.from(JSON.stringify(obj))); }
  send(data) { this.sent.push(JSON.parse(String(data))); }
  close() { this.readyState = 3; }
  terminate() { this.readyState = 3; }
}

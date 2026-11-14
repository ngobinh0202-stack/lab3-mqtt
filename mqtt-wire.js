(function (root) {
  "use strict";

  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", {fatal: true});
  const keepAliveSeconds = 25;
  const maximumPacketSize = 65536;

  function mqttString(value) {
    const bytes = encoder.encode(value);
    if (bytes.length > 65535) throw new Error("Chuỗi MQTT quá dài.");
    return [bytes.length >>> 8, bytes.length & 255, ...bytes];
  }

  function packet(header, payload = []) {
    const remainingLength = [];
    let remaining = payload.length;
    do {
      const digit = remaining & 127;
      remaining >>= 7;
      remainingLength.push(digit | (remaining ? 128 : 0));
    } while (remaining);
    return Uint8Array.from([header, ...remainingLength, ...payload]);
  }

  class MqttWire {
    constructor({url, topic, status, message}) {
      this.topic = topic;
      this.status = status;
      this.message = message;
      this.buffer = new Uint8Array();
      this.ready = false;
      this.stopped = false;
      this.connectAccepted = false;
      this.pingAt = null;
      const clientId = "runner-web-" + Math.random().toString(36).slice(2, 14);
      this.socket = new WebSocket(url, "mqtt");
      this.socket.binaryType = "arraybuffer";
      this.deadline = setTimeout(() => this.stop("timeout"), 9000);
      this.socket.onopen = () => {
        this.send(0x10, [...mqttString("MQTT"), 4, 2, 0, keepAliveSeconds, ...mqttString(clientId)]);
      };
      this.socket.onmessage = ({data}) => {
        if (this.stopped) return;
        try {
          if (!(data instanceof ArrayBuffer)) throw new Error("WebSocket text frame");
          this.receive(new Uint8Array(data));
        } catch {
          this.stop("protocol");
        }
      };
      this.socket.onerror = () => this.stop("error");
      this.socket.onclose = () => this.stop("closed");
    }

    send(header, payload) {
      if (this.socket.readyState !== WebSocket.OPEN || this.stopped) return false;
      this.socket.send(packet(header, payload));
      return true;
    }

    receive(chunk) {
      if (this.buffer.length + chunk.length > maximumPacketSize) throw new Error("Large packet");
      const bytes = new Uint8Array(this.buffer.length + chunk.length);
      bytes.set(this.buffer);
      bytes.set(chunk, this.buffer.length);
      let start = 0;
      while (start + 1 < bytes.length) {
        let cursor = start + 1;
        let length = 0;
        let multiplier = 1;
        let complete = false;
        for (let digit = 0; digit < 4 && cursor < bytes.length; digit++) {
          const value = bytes[cursor++];
          length += (value & 127) * multiplier;
          if (!(value & 128)) {
            complete = true;
            break;
          }
          if (digit === 3) throw new Error("Malformed remaining length");
          multiplier *= 128;
        }
        if (length > maximumPacketSize) throw new Error("Large packet");
        const end = cursor + length;
        if (!complete || end > bytes.length) break;
        this.handle(bytes[start], bytes.subarray(cursor, end));
        start = end;
      }
      this.buffer = bytes.slice(start);
    }

    handle(header, body) {
      if (header === 0x20 && !this.connectAccepted) {
        if (body.length !== 2 || body[0] !== 0 || body[1] !== 0) throw new Error("CONNECT refused");
        this.connectAccepted = true;
        this.send(0x82, [0, 1, ...mqttString(this.topic), 0]);
        return;
      }
      if (header === 0x90 && this.connectAccepted && !this.ready) {
        if (body.length !== 3 || body[0] !== 0 || body[1] !== 1 || body[2] !== 0) {
          throw new Error("SUBSCRIBE refused");
        }
        clearTimeout(this.deadline);
        this.ready = true;
        this.status("ready");
        this.heartbeat = setInterval(() => {
          if (this.pingAt !== null) {
            if (Date.now() - this.pingAt >= 12000) this.stop("timeout");
          } else if (this.send(0xc0)) {
            this.pingAt = Date.now();
          }
        }, 12000);
        return;
      }
      if (header === 0xd0 && body.length === 0 && this.ready) {
        this.pingAt = null;
        return;
      }
      if ((header >>> 4) !== 3 || !this.ready) throw new Error("Unexpected packet");
      if ((header & 6) !== 0 || body.length < 2) throw new Error("Invalid PUBLISH");
      const length = body[0] * 256 + body[1];
      if (!length || length + 2 > body.length) throw new Error("Invalid topic length");
      const topic = decoder.decode(body.subarray(2, 2 + length));
      if (topic !== this.topic || (header & 1)) return;
      this.message(decoder.decode(body.subarray(2 + length)));
    }

    publish(topic, payload) {
      if (!this.ready) return false;
      return this.send(0x30, [...mqttString(topic), ...encoder.encode(payload)]);
    }

    stop(reason) {
      if (this.stopped) return;
      if (this.ready && reason === "manual") this.send(0xe0);
      this.stopped = true;
      this.ready = false;
      clearTimeout(this.deadline);
      clearInterval(this.heartbeat);
      if (this.socket.readyState < WebSocket.CLOSING) this.socket.close();
      this.status(reason);
    }
  }

  root.MqttWire = MqttWire;
}(globalThis));

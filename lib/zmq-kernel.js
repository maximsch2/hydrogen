/* @flow */

import fs from "fs";
import { Message, Socket } from "jmp";
import v4 from "uuid/v4";

import Kernel from "./kernel";
import InputView from "./input-view";
import kernelManager from "./kernel-manager";
import { log } from "./utils";

type Connection = {
  control_port: number,
  hb_port: number,
  iopub_port: number,
  ip: string,
  key: string,
  shell_port: number,
  signature_scheme: string,
  stdin_port: number,
  transport: string,
  version: number
};
/* eslint-disable camelcase */
export default class ZMQKernel extends Kernel {
  executionCallbacks: Object = {};
  connection: Connection;
  connectionFile: string;
  kernelProcess: child_process$ChildProcess;

  shellSocket: Socket;
  controlSocket: Socket;
  stdinSocket: Socket;
  ioSocket: Socket;

  constructor(
    kernelSpec: Kernelspec,
    grammar: atom$Grammar,
    connection: Connection,
    connectionFile: string,
    kernelProcess: child_process$ChildProcess
  ) {
    super(kernelSpec, grammar);
    this.connection = connection;
    this.connectionFile = connectionFile;
    this.kernelProcess = kernelProcess;

    if (this.kernelProcess) {
      log("ZMQKernel: @kernelProcess:", this.kernelProcess);

      this.kernelProcess.stdout.on("data", (data: string | Buffer) => {
        data = data.toString();

        if (atom.config.get("Hydrogen.kernelNotifications")) {
          atom.notifications.addInfo(this.kernelSpec.display_name, {
            description: data,
            dismissable: true
          });
        } else {
          log("ZMQKernel: stdout:", data);
        }
      });

      this.kernelProcess.stderr.on("data", (data: string | Buffer) => {
        atom.notifications.addError(this.kernelSpec.display_name, {
          description: data.toString(),
          dismissable: true
        });
      });
    } else {
      log("ZMQKernel: connectionFile:", this.connectionFile);
      atom.notifications.addInfo("Using an existing kernel connection");
    }
  }

  connect(done: ?Function) {
    const scheme = this.connection.signature_scheme.slice("hmac-".length);
    const { key } = this.connection;

    this.shellSocket = new Socket("dealer", scheme, key);
    this.controlSocket = new Socket("dealer", scheme, key);
    this.stdinSocket = new Socket("dealer", scheme, key);
    this.ioSocket = new Socket("sub", scheme, key);

    const id = v4();
    this.shellSocket.identity = `dealer${id}`;
    this.controlSocket.identity = `control${id}`;
    this.stdinSocket.identity = `dealer${id}`;
    this.ioSocket.identity = `sub${id}`;

    const address = `${this.connection.transport}://${this.connection.ip}:`;
    this.shellSocket.connect(address + this.connection.shell_port);
    this.controlSocket.connect(address + this.connection.control_port);
    this.ioSocket.connect(address + this.connection.iopub_port);
    this.ioSocket.subscribe("");
    this.stdinSocket.connect(address + this.connection.stdin_port);

    this.shellSocket.on("message", this.onShellMessage.bind(this));
    this.ioSocket.on("message", this.onIOMessage.bind(this));
    this.stdinSocket.on("message", this.onStdinMessage.bind(this));

    try {
      let socketNames = ["shellSocket", "controlSocket", "ioSocket"];

      let waitGroup = socketNames.length;
      function onConnect({ socketName, socket }) {
        log("ZMQKernel: " + socketName + " connected");
        socket.unmonitor();

        waitGroup--;
        if (waitGroup === 0) {
          log("ZMQKernel: all main sockets connected");
          if (done) done();
        }
      }

      monitor("shellSocket", this.shellSocket);
      monitor("controlSocket", this.controlSocket);
      monitor("ioSocket", this.ioSocket);
      function monitor(socketName, socket) {
        log("ZMQKernel: monitor " + socketName);
        socket.on("connect", onConnect.bind(this, { socketName, socket }));
        socket.monitor();
      }
    } catch (err) {
      console.error("ZMQKernel:", err);
    }
  }

  interrupt() {
    if (process.platform === "win32") {
      atom.notifications.addWarning("Cannot interrupt this kernel", {
        detail: "Kernel interruption is currently not supported in Windows."
      });
    } else if (this.kernelProcess) {
      log("ZMQKernel: sending SIGINT");
      this.kernelProcess.kill("SIGINT");
    } else {
      log("ZMQKernel: cannot interrupt an existing kernel");
      atom.notifications.addWarning("Cannot interrupt an existing kernel");
    }
  }

  _kill() {
    if (this.kernelProcess) {
      log("ZMQKernel: sending SIGKILL");
      this.kernelProcess.kill("SIGKILL");
    } else {
      log("ZMQKernel: cannot kill an existing kernel");
      atom.notifications.addWarning("Cannot kill this kernel");
    }
  }

  shutdown(restart: ?boolean = false) {
    const requestId = `shutdown_${v4()}`;
    const message = this._createMessage("shutdown_request", requestId);

    message.content = { restart };

    this.shellSocket.send(new Message(message));
  }

  restart(onRestarted: ?Function) {
    if (this.kernelProcess) {
      this.destroy(true);
      kernelManager.startKernel(this.kernelSpec, this.grammar, onRestarted);
      return;
    }

    log("ZMQKernel: restart ignored:", this);
    atom.notifications.addWarning("Cannot restart this kernel");
    if (onRestarted) onRestarted(this);
  }

  // onResults is a callback that may be called multiple times
  // as results come in from the kernel
  _execute(code: string, requestId: string, onResults: Function) {
    const message = this._createMessage("execute_request", requestId);

    message.content = {
      code,
      silent: false,
      store_history: true,
      user_expressions: {},
      allow_stdin: true
    };

    this.executionCallbacks[requestId] = onResults;

    this.shellSocket.send(new Message(message));
  }

  execute(code: string, onResults: Function) {
    log("Kernel.execute:", code);

    const requestId = `execute_${v4()}`;
    this._execute(code, requestId, onResults);
  }

  executeWatch(code: string, onResults: Function) {
    log("Kernel.executeWatch:", code);

    const requestId = `watch_${v4()}`;
    this._execute(code, requestId, onResults);
  }

  complete(code: string, onResults: Function) {
    log("Kernel.complete:", code);

    const requestId = `complete_${v4()}`;

    const message = this._createMessage("complete_request", requestId);

    message.content = {
      code,
      text: code,
      line: code,
      cursor_pos: code.length
    };

    this.executionCallbacks[requestId] = onResults;

    this.shellSocket.send(new Message(message));
  }

  inspect(code: string, cursorPos: number, onResults: Function) {
    log("Kernel.inspect:", code, cursorPos);

    const requestId = `inspect_${v4()}`;

    const message = this._createMessage("inspect_request", requestId);

    message.content = {
      code,
      cursor_pos: cursorPos,
      detail_level: 0
    };

    this.executionCallbacks[requestId] = onResults;

    this.shellSocket.send(new Message(message));
  }

  inputReply(input: string) {
    const requestId = `input_reply_${v4()}`;

    const message = this._createMessage("input_reply", requestId);

    message.content = { value: input };

    this.stdinSocket.send(new Message(message));
  }

  onShellMessage(message: Message) {
    log("shell message:", message);

    if (!this._isValidMessage(message)) {
      return;
    }

    const { msg_id } = message.parent_header;
    let callback;
    if (msg_id) {
      callback = this.executionCallbacks[msg_id];
    }

    if (!callback) {
      return;
    }

    const { status } = message.content;
    if (status === "error") {
      // Drop 'status: error' shell messages, wait for IO messages instead
      return;
    }

    if (status === "ok") {
      const { msg_type } = message.header;

      if (msg_type === "execution_reply") {
        callback({
          data: "ok",
          type: "text",
          stream: "status"
        });
      } else if (msg_type === "complete_reply") {
        callback(message.content);
      } else if (msg_type === "inspect_reply") {
        callback({
          data: message.content.data,
          found: message.content.found
        });
      } else {
        callback({
          data: "ok",
          type: "text",
          stream: "status"
        });
      }
    }
  }

  onStdinMessage(message: Message) {
    log("stdin message:", message);

    if (!this._isValidMessage(message)) {
      return;
    }

    const { msg_type } = message.header;

    if (msg_type === "input_request") {
      const { prompt } = message.content;

      const inputView = new InputView({ prompt }, (input: string) =>
        this.inputReply(input));

      inputView.attach();
    }
  }

  onIOMessage(message: Message) {
    log("IO message:", message);

    if (!this._isValidMessage(message)) {
      return;
    }

    const { msg_type } = message.header;

    if (msg_type === "status") {
      const status = message.content.execution_state;
      this.setExecutionState(status);

      const msg_id = message.parent_header
        ? message.parent_header.msg_id
        : null;
      if (msg_id && status === "idle" && msg_id.startsWith("execute")) {
        this._callWatchCallbacks();
      }
    }

    const { msg_id } = message.parent_header;
    let callback;
    if (msg_id) {
      callback = this.executionCallbacks[msg_id];
    }

    if (!callback) {
      return;
    }

    const result = this._parseIOMessage(message);

    if (result) {
      callback(result);
    }
  }
  /* eslint-enable camelcase*/

  _isValidMessage(message: Message) {
    if (!message) {
      log("Invalid message: null");
      return false;
    }

    if (!message.content) {
      log("Invalid message: Missing content");
      return false;
    }

    if (message.content.execution_state === "starting") {
      // Kernels send a starting status message with an empty parent_header
      log("Dropped starting status IO message");
      return false;
    }

    if (!message.parent_header) {
      log("Invalid message: Missing parent_header");
      return false;
    }

    if (!message.parent_header.msg_id) {
      log("Invalid message: Missing parent_header.msg_id");
      return false;
    }

    if (!message.parent_header.msg_type) {
      log("Invalid message: Missing parent_header.msg_type");
      return false;
    }

    if (!message.header) {
      log("Invalid message: Missing header");
      return false;
    }

    if (!message.header.msg_id) {
      log("Invalid message: Missing header.msg_id");
      return false;
    }

    if (!message.header.msg_type) {
      log("Invalid message: Missing header.msg_type");
      return false;
    }

    return true;
  }

  destroy(restart: ?boolean = false) {
    log("ZMQKernel: destroy:", this);

    this.shutdown(restart);

    if (this.kernelProcess) {
      this._kill();
      fs.unlink(this.connectionFile);
    }

    this.shellSocket.close();
    this.controlSocket.close();
    this.ioSocket.close();
    this.stdinSocket.close();

    super.destroy(...arguments);
  }

  _getUsername() {
    return process.env.LOGNAME ||
      process.env.USER ||
      process.env.LNAME ||
      process.env.USERNAME;
  }

  _createMessage(msgType: string, msgId: string = v4()) {
    const message = {
      header: {
        username: this._getUsername(),
        session: "00000000-0000-0000-0000-000000000000",
        msg_type: msgType,
        msg_id: msgId,
        date: new Date(),
        version: "5.0"
      },
      metadata: {},
      parent_header: {},
      content: {}
    };

    return message;
  }
}

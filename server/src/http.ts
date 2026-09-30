/** An error the Worker reports to the client as `{ error }` with this status. */
export class HttpError extends Error {
  status: number;
  /** Sent as `code` beside the message, when the client needs to tell this refusal from others. */
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

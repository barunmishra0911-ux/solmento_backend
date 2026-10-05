export class HttpError extends Error {
  constructor(status, message, details = undefined) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.details = details;
  }
}

export function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

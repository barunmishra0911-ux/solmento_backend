export function notFoundHandler(_req, res) {
  return res.status(404).json({ success: false, message: "Route not found." });
}

export function errorHandler(error, _req, res, _next) {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({
    success: false,
    message: status >= 500 ? "An unexpected server error occurred." : error.message,
    ...(error.details ? { details: error.details } : {}),
  });
}

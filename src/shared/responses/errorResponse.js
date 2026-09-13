export function errorResponse({ code, message, details, requestId } = {}) {
  return {
    success: false,
    error: {
      code: code || "INTERNAL_ERROR",
      message: message || "Internal server error",
      ...(details !== undefined ? { details } : {}),
    },
    ...(requestId ? { requestId } : {}),
  };
}

export default errorResponse;

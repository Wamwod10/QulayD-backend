export function successResponse({ data = null, message, meta, requestId } = {}) {
  return {
    success: true,
    ...(message ? { message } : {}),
    data,
    ...(meta ? { meta } : {}),
    ...(requestId ? { requestId } : {}),
  };
}

export function sendSuccess(response, {
  statusCode = 200,
  data = null,
  message,
  meta,
} = {}) {
  return response.status(statusCode).json(successResponse({
    data,
    message,
    meta,
    requestId: response.locals.requestId,
  }));
}

export default sendSuccess;

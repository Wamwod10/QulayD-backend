export function asyncHandler(handler) {
  return function wrappedHandler(request, response, next) {
    return Promise.resolve(handler(request, response, next)).catch(next);
  };
}

export default asyncHandler;

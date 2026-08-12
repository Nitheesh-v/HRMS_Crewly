class ApiResponse {
  static success(res, { statusCode = 200, message = 'Success', data = null, meta = null } = {}) {
    const body = { success: true, message, data };
    if (meta) body.meta = meta;
    return res.status(statusCode).json(body);
  }

  static created(res, options = {}) {
    return ApiResponse.success(res, { ...options, statusCode: 201, message: options.message || 'Created successfully' });
  }
}

export default ApiResponse;
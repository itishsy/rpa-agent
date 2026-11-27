'use strict'

const NOT_PERSISTED_MESSAGE = '登录成功，但当前运行环境无法保存登录偏好。请从桌面快捷方式启动 rpa-agent，以便持久化账号和设置。'

function persistLoginPreferences({ settings, user, rememberPassword, password, save }) {
  const previous = settings.userLogin
  settings.userLogin = {
    baseUrl: user.baseUrl,
    username: user.username,
    ...(rememberPassword === true ? { rememberPassword: true, password: String(password) } : {})
  }
  try {
    save()
    return { saved: true, warning: '' }
  } catch (error) {
    settings.userLogin = previous
    return { saved: false, warning: NOT_PERSISTED_MESSAGE, error }
  }
}

module.exports = { NOT_PERSISTED_MESSAGE, persistLoginPreferences }

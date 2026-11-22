export async function openCodeLogin(page) {
  await page.locator('.login-panel .token-login-trigger').dblclick()
  await page.getByRole('button', { name: '验证码或邀请', exact: true }).click()
}

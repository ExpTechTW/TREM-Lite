// const os = require('node:os');
// const { app } = require('@electron/remote');
// class Login {
//   constructor() {
//     this.config = require('./config');
//     this.store = require('./store');
//     this.storeData = new this.store();
//     this.Instance = this.config.Instance;
//     this.account = document.querySelector('.account');
//     this.vipTime = document.querySelector('.vip-time');
//     this.formLogin = document.querySelector('.form-login');
//     this.loginBack = document.querySelector('.login-back');
//     this.loginBtn = document.querySelector('.login-btn');
//     this.logoutBtn = document.querySelector('.logout-btn');
//     this.loginMessage = document.querySelector('.login-msg');
//     this.loginFormContent = document.querySelector('.login-forms-content');
//     this.accountInfoContent = document.querySelector('.account-info-content');
//     this.email = document.querySelector('.email');
//     this.password = document.querySelector('.password');
//     this.buyVip = document.querySelector('.buy-vip');
//     this.url = 'https://api-1.exptech.dev/api/v3/et/';
//     this.clickEvent();
//     this.clickEvent = new MouseEvent('click', {
//       bubbles: 1,
//       cancelable: 1,
//       view: window,
//     });
//   }

//   async fetchData(endpoint, options) {
//     try {
//       const res = await fetch(`${this.url}${endpoint}`, options);
//       const res_data = options == 'info' ? await res.json() : await res.text();
//       return { res, options, res_data };
//     }
//     catch (error) {
//       console.error('Error:', error);
//     }
//   }

//   clickEvent() {
//     this.loginBtn.addEventListener('click', () => this.toggleForm(true));
//     this.loginBack.addEventListener('click', () => this.toggleForm(false));
//     this.formLogin.addEventListener('click', async () => {
//       const { res, options, res_data } = await this.fetchData('login', {
//         method: 'POST',
//         headers: { 'Content-Type': 'application/json' },
//         body: JSON.stringify({
//           email: this.email.value,
//           pass: this.password.value,
//           name: `/TREM-Lite/${app.getVersion()}/${os.release()}`,
//         }),
//       });
//       this.handle(res, options, res_data, 1);
//     });
//     this.logoutBtn.addEventListener('click', async () => {
//       const { res, options, res_data } = await this.fetchData('logout', {
//         method: 'DELETE',
//         headers: {
//           'Content-Type': 'application/json',
//           'Authorization': `Basic ${this.token}`,
//         },
//       });
//       this.handle(res, options, res_data, 2);
//     });
//   }

//   toggleForm(isLogin) {
//     this.loginFormContent.style.display = isLogin ? 'grid' : 'none';
//     this.accountInfoContent.style.display = isLogin ? 'none' : 'flex';
//     requestAnimationFrame(() => {
//       this.loginFormContent.classList.toggle('show-login-form', isLogin);
//       this.accountInfoContent.classList.toggle('show-account-info', !isLogin);
//     });
//   }

//   async handle(res, options, data, type) {
//     const status = res.ok;
//     const action = options.method == 'POST' ? '登入' : '登出';
//     this.loginMessage.className = status ? 'success' : 'error';
//     this.loginMessage.textContent = status
//       ? `${action}成功！`
//       : res.status == 400 || res.status == 401
//         ? '帳號或密碼錯誤！'
//         : `伺服器異常(error ${res.status})`;

//     if (status) {
//       const { res_data } = await this.fetchData('info', {
//         method: 'GET',
//         headers: {
//           'Content-Type': 'application/json',
//           'Authorization': `Basic ${data}`,
//         },
//       });
//       this.render(JSON.parse(res_data), type);
//     }
//   }

//   render(msg, type) {
//     const button = type === 1 ? this.loginBtn : this.logoutBtn;
//     const button_ = type === 1 ? this.logoutBtn : this.loginBtn;
//     const display = type === 1 ? 'show' : 'none';
//     button.classList.add('show');
//     button_.classList.add('none');
//     this.email.value = '';
//     this.password.value = '';
//     this.account.textContent = !msg ? '' : msg.email;
//     this.vipTime.textContent = !msg ? '尚未登入' : msg.vip > 0 ? this.storeData.formatTime(msg.vip) : '';
//     button.dispatchEvent(this.clickEvent);
//     this.buyVip.classList.add(display);
//     this.loginBack.click();
//   }
// }
// new Login();

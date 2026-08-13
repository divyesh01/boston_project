export default async function run(base44) {
  try {
    const res = await base44.functions.invoke('custom_auth_login', {
      email: 'divyesh.boston@gmail.com',
      password: '22112004@Djvp'
    });
    console.log('Login Result:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('Login Failed:', err.message);
  }
}

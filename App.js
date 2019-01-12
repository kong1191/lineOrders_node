var app = require('./app_router.js')

//The 'process' object is a global that provides information about, and control over, the current Node.js process.
//As a global, it is always available to Node.js applications without using require().
//The 'process.env' property returns an object containing the user environment.
//you can set the environment variable 'PORT' to tell your web server what port to listen on.
const port = process.env.PORT || 8080;
//whatever is in the environment variable 'PORT', or 8080 if there's nothing there

//binds and listens for connections on the specified host and port. This method is identical to Node’s http.Server.listen().
app.listen(port);
console.log(`MERN Stack listening on ${port}`);

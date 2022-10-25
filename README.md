# try_files()
A Deno server for efficiently serving static files and passing unknown URLs to your app, inspired by nginx's try_files directive.

## Quick Start
If you use a "public" dir for your project,
try running this from your project directory:
```bash
deno run --allow-net --allow-read https://deno.land/x/try_files/server.js
```

## Features
- Zero script dependencies
- Dynamic CORS headers with OPTIONS handling
- Efficient cache headers
- 304 not modified based on mtime or etag
- Byte ranges, 206 partial content
- Optional memory caching of static files
- Proper server shutdown with SIGINT

## By Example
This simple script uses try_files to serve static assets from the "public" directory 
before serving our custom page, which should also provide the 404 response when an app route is not found.
```javascript
import { try_files } from "https://deno.land/x/try_files/mod.js";

try_files(async function(request){
    let { pathname } = new URL(request.url);
    
    if(pathname === '/')
        return new Response('Welcome to my homepage!');
    
    return new Response('This is my 404 page!',{status:404});
});
```
This example builds on the previous one and demonstrates the options available
to modify how try_files works:
```javascript
import { try_files } from "https://deno.land/x/try_files/mod.js";

const options = {
    port:8080,
    filesDir:'public',
    index:'index.html',
    corsMatch:'*', //undefined|'*'|RegExp
    memoryCache:false,
    byteRangeChunk: 1024 * 256,
    async beforeClose(){
        //this will fire after SIGINT but before the server.close()
        // ideal for passing along to child processes
        console.log('not without me!')
    },
}

try_files(async function(request){
    let { pathname } = new URL(request.url);
    if(pathname === '/') return new Response('Welcome to my homepage!');
    return new Response('This is my 404 page!',{status:404});
}, options);
```

export interface try_files_options {
    port?:number;
    filesDir?:string;
    index?:string;
    corsMatch?:string|RegExp;
    memoryCache?:boolean;
    byteRangeChunk?:number;
    beforeClose?:()=>Promise<void>;
}
interface StringByString {
    [key: string]: string;
}
interface Uint8ArrayByString {
    [key: string]: Uint8Array;
}

const encoder = new TextEncoder();
const staticCache:Uint8ArrayByString = {};
const staticCacheVersions:StringByString = {};

export function try_files (
    next:(request: Request)=>Promise<Response> = async _request => await new Response('Not Found',{status:404}),//app pages & endpoints
    {
        port = 8080,
        filesDir = 'public',
        index = 'index.html',
        corsMatch = undefined, // string=simple GET mode for *; RegExp=dynamic, max permissions}
        memoryCache = false,
        byteRangeChunk = 1024 * 256,
        beforeClose = async function(){},
    }:try_files_options = {}
) {

    //BUILD FUNCTIONS based on user options
    let addCORS = function(_request: Request, responseHeaders: Headers){return responseHeaders;};
    if(corsMatch === '*'){
        addCORS = function(_request, responseHeaders){
            responseHeaders.append('access-control-allow-origin', '*');
            responseHeaders.append('access-control-allow-methods', 'OPTIONS,HEAD,GET');
            responseHeaders.append('access-control-allow-headers', '*');//allow anything except Authorization when not using credentials
            return responseHeaders;
        }
    } else if(corsMatch instanceof RegExp){
        addCORS = function(request, responseHeaders){
            const origin = request.headers.get('origin');
            if(origin && corsMatch.test(origin)){
                responseHeaders.append('access-control-allow-origin', origin);
                responseHeaders.append('access-control-allow-methods', 'OPTIONS,HEAD,GET,POST,PATCH,PUT,DELETE');
                //have to specify everything when allowing credentials
                responseHeaders.append('access-control-allow-headers', 'Accept,Accept-Language,Authorization,Cache-Control,If-Modified-Since,Content-Language,Content-Type,Expires,Last-Modified,Pragma,Range,User-Agent,X-Requested-With');
                responseHeaders.append('access-control-allow-credentials', 'true');
                responseHeaders.append('access-control-max-age', '604800');//cache for 7 days
            }
            return responseHeaders;
        }
    }



    /**
     * @type Request
     */
    return serve(async function(request){
        let { pathname, search } = new URL(request.url);
        if(pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.substring(0, pathname.length-1);

        //START RESPONSE
        let responseData:null|string|Uint8Array = null;
        const headers = new Headers();

        //OPTIONS: 204 no content, cors
        if(request.method === 'OPTIONS'){
            return new Response(null, {
                status: 204,
                headers: addCORS(request, headers),
            });
        }

        //GET | HEAD: we can try files
        if(request.method === 'GET' || request.method === 'HEAD'){

            try { //TRY FILES
                let filename = `./${filesDir}${decodeURI(pathname)}`;
                const requestedFile = await Deno.stat(filename);

                let finfo, isIndex = false;
                if(requestedFile.isFile){
                    finfo = requestedFile;
                } else if(requestedFile.isDirectory){
                    filename = pathname === '/' ? `./${filesDir}/${index}` : `./${filesDir}${pathname}/${index}`;
                    const indexFile = await Deno.stat(filename);
                    if(indexFile.isFile){
                        finfo = indexFile;
                        isIndex = true;
                    }
                }
                if(finfo){
                    //FILE EXTENSION
                    let ext:RegExpMatchArray|string|null = filename.toLowerCase().match(/^.+\.(\w+)$/);
                    if(ext) ext = ext[1];//get match

                    //last-modified header vs if-modified-since, possible 304
                    if(finfo.mtime){
                        headers.append('last-modified', finfo.mtime.toUTCString());
                        const ifModSince = request.headers.get('if-modified-since');
                        if(ifModSince && finfo.mtime > new Date(Date.parse(ifModSince))){
                            //it has not been modified, return 304
                            return new Response(null, {
                                status: 304,
                                headers: addCORS(request, headers),
                            });
                        }
                    }

                    //we didn't 304, continue trying to serve the file -- accept byte ranges
                    headers.set('accept-ranges','bytes');
                    let length = finfo.size;
                    let start = 0;
                    let end = length - 1;
                    const range = request.headers.get('range');
                    let isServingRange = false;
                    if(range && !isIndex){
                        const matches = range.match(/bytes=(\d+)-(\d+)?/);
                        start = matches && matches[1] ? parseInt(matches[1]) : 0;
                        if(matches && matches[2] !== undefined){
                            //specific range
                            end = parseInt(matches[2]);
                        } else {
                            //start only
                            end = finfo.size - 1;
                            const chunked = start + byteRangeChunk;
                            end = Math.min(chunked, end);
                        }
                        length = end - start + 1;
                        if(start > 0 || length < finfo.size){
                            headers.append('content-range',`bytes ${start}-${end}/${finfo.size}`);
                            isServingRange = true;
                        }
                    }
                    //always set length so we can send it with empty HEAD requests
                    headers.append('content-length', length.toString());

                    //cache some static assets in memory, but refresh based on ?search
                    if(!isIndex && memoryCache){
                        if(!staticCache[pathname] || search !== staticCacheVersions[pathname]){
                            staticCache[pathname] = await Deno.readFile(filename);
                            staticCacheVersions[pathname] = search;
                        }
                        responseData = staticCache[pathname].slice(start, start+length);
                    } else if(Deno.seek) {
                        //READ FILE
                        responseData = new Uint8Array(length);
                        const file = await Deno.open(filename,{read:true});
                        await Deno.seek(file.rid,start,Deno.SeekMode.Start);
                        let bytesRead = 0;
                        while(bytesRead < length){
                            const n = await Deno.read(file.rid, responseData);
                            if(n) bytesRead += n;
                            else break;
                        }
                        await Deno.close(file.rid);
                    } else {
                        //READ ENTIRE FILE
                        // todo this is a fallback for deno deploy not supporting Deno.seek
                        responseData = await Deno.readFile(filename);
                    }


                    //didn't return a range, check etag - possible 304 again
                    const ifNoneMatch = request.headers.get('if-none-match');
                    if(!finfo.mtime || ifNoneMatch){
                        const etag = await calculate(responseData);
                        headers.append('etag', etag);
                        if(ifNoneMatch && ifNoneMatch.indexOf(etag) > -1){
                            //etag was specified, return 304
                            return new Response(null, {
                                status: 304,
                                headers: addCORS(request, headers),
                            });
                        }
                    }

                    //set max cache headers for files with extensions (unless isIndex)
                    if(ext && !isIndex){
                        headers.append('cache-control','public, max-age=31536000');
                    } else {
                        headers.append('cache-control','no-cache');
                    }

                    //always set mime types w/ catchall
                    if(ext && ext in mimeTypes) headers.append('content-type', mimeTypes[ext] as string);
                    else headers.append('content-type','application/octet-stream');

                    //SUCCESS
                    if(request.method === 'GET'){
                        return new Response(responseData, {
                            status: isServingRange ? 206 : 200,
                            headers: addCORS(request, headers),
                        });
                    } else {//skip body b/c head req
                        return new Response(null, {
                            status: 204,
                            headers: addCORS(request, headers),
                        });
                    }
                }
            } catch (err) {
                //static file fail - continue to app router
                if(!(err instanceof Deno.errors.NotFound)){
                    console.error(new Date(), 'Error in try_files()', err);// error, log it!!
                }
            }
        }

        //APP ROUTER - no response, hand off to app
        const response = await next(request);
        addCORS(request, response.headers);//successful app responses add cors too
        return response;
    }, {
        port,
        beforeClose,
    });
}


//serve() wraps listen() so we can just return a Response
export function serve(
    handler:(req:Request)=>Promise<Response> = async _request => await new Response('Hello World'),
    {
        port = 8080,
        beforeClose = async function(){},
    }
){
    listen(async function (request, respond) {
        try {
            respond(await handler(request))
        } catch (err){
            console.error(new Date(), 'Error from handler()', err);
            respond(new Response('Server Error',{status:500}));
        }
    }, {port,beforeClose}).catch(err => console.error(new Date(), 'Error from listen()', err));
}

async function listen(
    handler:(request:Request,respond:(response:Response)=>void)=>Promise<void> = async function(_request,respond){respond(await new Response('Hello World'))},
    {
        port = 8080,
        beforeClose = async function(){},
    }
){
    const server = Deno.listen({port});

    Deno.addSignalListener('SIGINT', async function(){
        console.log('Shutting down server');
        await beforeClose();
        await server.close();
        console.log('Goodbye!')
        Deno.exit();
    })

    async function _serveHttp(conn: Deno.Conn) {
        for await (const e of Deno.serveHttp(conn)) {
            e.respondWith(new Promise(function(resolve){
                //do not await or it will block other requests
                handler(e.request, resolve);
            })).catch(err => console.error(new Date(), 'Error from respondWith()', err))
        }
    }

    console.log(`Listening on http://localhost:${port}/`);

    for await (const conn of server) {
        //do not await or it will block other connections
        _serveHttp(conn).catch(err => console.error(new Date(), 'Error from _serveHttp()', err));
    }
}



// ETAG DEPS

const base64abc = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z",
    "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m", "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
    "0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+", "/"];
/**
 * CREDIT: https://gist.github.com/enepomnyaschih/72c423f727d395eeaa09697058238727
 * Encodes a given Uint8Array, ArrayBuffer or string into RFC4648 base64 representation
 * @param data
 */
function base64_encode(data: string|Uint8Array|ArrayBuffer): string {
    const uint8 = typeof data === "string"
        ? encoder.encode(data)
        : data instanceof Uint8Array
            ? data
            : new Uint8Array(data);
    let result = "",
        i;
    const l = uint8.length;
    for (i = 2; i < l; i += 3) {
        result += base64abc[uint8[i - 2] >> 2];
        result += base64abc[((uint8[i - 2] & 0x03) << 4) | (uint8[i - 1] >> 4)];
        result += base64abc[((uint8[i - 1] & 0x0f) << 2) | (uint8[i] >> 6)];
        result += base64abc[uint8[i] & 0x3f];
    }
    if (i === l + 1) {
        // 1 octet yet to write
        result += base64abc[uint8[i - 2] >> 2];
        result += base64abc[(uint8[i - 2] & 0x03) << 4];
        result += "==";
    }
    if (i === l) {
        // 2 octets yet to write
        result += base64abc[uint8[i - 2] >> 2];
        result += base64abc[((uint8[i - 2] & 0x03) << 4) | (uint8[i - 1] >> 4)];
        result += base64abc[(uint8[i - 1] & 0x0f) << 2];
        result += "=";
    }
    return result;
}

/**
 * Decodes a given RFC4648 base64 encoded string
 * @param b64
 */
/*function base64_decode(b64: string): Uint8Array {
    const binString = atob(b64);
    const size = binString.length;
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
        bytes[i] = binString.charCodeAt(i);
    }
    return bytes;
}*/

//thank you oak
async function calculate(entity: string|Uint8Array|Deno.FileInfo, weak = true): Promise<string> {
    const tag = isFileInfo(entity)
        ? calcStatTag(entity as Deno.FileInfo)
        : await calcEntityTag(entity as string|Uint8Array);

    return weak ? `W/${tag}` : tag;
}
function isFileInfo(value: string|Uint8Array|Deno.FileInfo): boolean {
    return Boolean(value && typeof value === "object" && "mtime" in value && "size" in value);
}
function calcStatTag(entity: Deno.FileInfo): string {
    const mtime = entity.mtime?.getTime().toString(16) ?? "0";
    const size = entity.size.toString(16);
    return `"${size}-${mtime}"`;
}
async function calcEntityTag(entity: string|Uint8Array): Promise<string> {
    if (entity.length === 0) return `"0-2jmj7l5rSw0yVb/vlWAYkK/YBwk="`;
    if (typeof entity === "string") {
        entity = encoder.encode(entity);
    }
    const hash = base64_encode(await crypto.subtle.digest("SHA-1", entity)).substring(0, 27);
    return `"${entity.length.toString(16)}-${hash}"`;
}

//handle most common assets, fallback to octet-stream
const mimeTypes:StringByString = {

    //scripts & styles
    css: 'text/css',
    js:  'text/javascript',
    map: 'text/plain',

    //text
    txt:  'text/plain',
    htm:  'text/html',
    html: 'text/html',
    xml:  'text/xml',
    ini:  'text/plain',
    conf: 'text/plain',
    yaml: 'text/yaml',
    yml:  'text/yaml',

    //images
    jpeg: 'image/jpeg',
    jpg:  'image/jpeg',
    bmp:  'image/bmp',
    png:  'image/png',
    apng: 'image/apng',
    webp: 'image/webp',
    avif: 'image/avif',
    gif:  'image/gif',
    ico:  'image/ico',
    svg:  'image/svg+xml',

    //audio
    mp3:  'audio/mp3',
    wav:  'audio/wav',
    ogg:  'audio/ogg',
    aac:  'audio/x-aac',
    m4a:  'audio/x-m4a',
    aiff: 'audio/x-aiff',
    flac: 'audio/x-flac',
    weba: 'audio/webm',
    midi: 'audio/midi',

    //video
    mp4:  'video/mp4',
    mpeg: 'video/mpeg',
    mpg:  'video/mpeg',
    webm: 'video/webm',
    avi:  'video/x-msvideo',
    '3gp':'video/3gpp',
    mov:  'video/quicktime',
    mkv:  'video/x-matroska',
    flv:  'video/x-flv',

    //fonts
    otf:  'font/otf',
    ttf:  'font/ttf',
    woff: 'font/woff',
    woff2:'font/woff2',

    //applications
    json: 'application/json',
    pdf:  'application/pdf',
    zip:  'application/zip',
    gz:   'application/gzip',
}

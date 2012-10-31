/* 
 * Datamanager node server
 * -----------------------
 * 
 *  http://127.0.0.1:5984/_dm/db_name/action?param=titi
 * 
 * Actions are located in server/action
 * libs are located in server/lib
 * 
 * config
 * ------
 * [httpd_global_handlers]
 * _dm = {couch_httpd_proxy, handle_proxy_req, <<"http://127.0.0.1:5995">>}
 *
 * [os_daemons]
 * dm_server = /path/to/nodejs /path/to/server.js

 */
 

var
http = require('http'),
vm = require('vm'),
url = require('url'),
couchdb = require('plantnet-node-couchdb');


function log(msg) {
    console.log(JSON.stringify(["log", JSON.stringify(msg)]));  
}

process.on('uncaughtException', function(err) {
               log("ERROR : " + err.stack || err.message);
});



/* ActionHandler object is sent to action handler */
var ActionHandler =  function (r, method, dbname, db, action, path, params) {
    this.r = r;
    this.method = method;
    this.dbname = dbname;
    this.db = db;
    this.action = action;
    this.path = path;
    this.params = params;

    // member to save code
    this.server_lib = null;
    this.server_action = null;
    
};

ActionHandler.cache = {}; // cache for _design/datamanager
ActionHandler.prototype = {};

// initialization
// get code from _design/datamanager doc
// use etag to cache data
ActionHandler.prototype.init = function (cb) {
    var docid = "_design/datamanager";

    var self = this, etag, cached_doc = ActionHandler.cache[self.dbname];

    // cache with etags
    if(cached_doc) { etag = cached_doc._rev; }

    self.db.getDocEtag(docid, etag,

                function (er, data) {
                    if(er === 404) {
                        throw "not a datamanager db";
                    }
                    if(er === 304 && cached_doc) { // not modified
                        data = cached_doc;
                    } 
                    if (data) {
                        try {
                            ActionHandler.cache[self.dbname] = data; // save cache
                            self.server_lib = data.server.lib;
                            self.server_action = data.server.action;
                            cb();

                        } catch (x) {
                            cb(x);
                        }
                    } 
                });
};

// return an error 400
ActionHandler.prototype.send_error = function (err) {

    this.r.writeHead(400, {"Content-Type": "application/json"});    
    if(typeof err != "string")  {
        err = JSON.stringify(err);
    }
    this.r.end("{error:'" + err + "'}");
};


// return a json object (code 200)
ActionHandler.prototype.send_json = function (json_data) {

    this.r.writeHead(200, {'Content-Type': 'application/json'});
    this.r.end(JSON.stringify(json_data) +'\n');
};


// return a file (code 200)
ActionHandler.prototype.send_file = function (str_data, filename) {

    this.r.writeHead(200, {'Content-Type': 'application/force-download',
                           //"Content-Transfer-Encoding": "application/octet-stream\n",
		           "Content-disposition": "attachment; filename=" + filename,
                           'Content-Length': str_data.length,
		           "Pragma": "no-cache", 
                           "Cache-Control": "must-revalidate, post-check=0, pre-check=0, public",
                           "Expires": "0"
                          });
    this.r.end(str_data);
};

// get a lib
ActionHandler.prototype.require = function (lib_name) {

    var self = this, lib_src = this.server_lib[lib_name], lib, exports = {};
    this.lib_cache = this.lib_cache || {}; // cache libs

    if(this.lib_cache[lib_name]) {
        return this.lib_cache[lib_name];
    }
    this.lib_cache[lib_name] = "processing"; // avoid infinite require loop;

    if(lib_src) {
        try {
            vm.runInNewContext(lib_src, { 
                exports : exports,
                log : function () { log(arguments) }, // closure
                require : function (libname) { // closure
                    if(self.lib_cache[libname] === "processing") {
                        throw "Infinite loop in require";
                    }
                                       return self.require(libname);
                },
                Buffer : Buffer
                
            });
        } catch (x) {
            self.send_error("" + x);
        }
    }

    this.lib_cache[lib_name] = exports;
    return exports;
};

// run an action
ActionHandler.prototype.run_action = function () {

    var self = this, 
    action_src = this.server_action[this.action + "." + this.method.toLowerCase()] ||
        this.server_action[this.action];


    if(action_src) {
        try {
            // execute action in sandbox
            vm.runInNewContext(action_src, { 
                db : self.db,
                q : self,
                log : function () { log(arguments) }, // closure
                require : function (libname) { // closure
                    return self.require(libname);
                },
                Buffer : Buffer
                               });
        } catch (x) {
            self.send_error("" + x);
        }
    } else {
        self.send_error("unknown action " + this.action);
    }
};


/*
 * *********************************************************************
 * */

function process_req(q) {
    log("run action " + q.action);
    // load code for action
    q.init(function (err, data) {
               if(err) {
                   q.send_error(err);
               } else {
                   q.run_action();
               }
           });
}


// parse and process an request
function parse_req(req, res) {
    
    try{
        var parsed_url = url.parse(req.url, true),
        urls = parsed_url.pathname.split("/"),
        dbname = urls[1],
        action = urls[2];

        var client = couchdb.createClient(5984, "localhost", null, null, 0, 0, req.headers.cookie),
        db = client.db(dbname),
        q = new ActionHandler(res, req.method, dbname, db, action, 
                              urls.slice(1), parsed_url.query);

        if(!dbname || !action) {
            q.send_error("bad url");
            return;
        }


        // POST
        if (req.method == 'POST') {
            var body = '';
            req.on('data', function (data) {
                       body += data;
                   });
            req.on('end', function () {
                       q.data = body;
                       process_req(q);
                   });
        } else {
            process_req(q);
        }
        
    } catch (x) {
        log("error :" + x);
    }
}


function main () {
    http.globalAgent.maxSockets = 20;

    // stdin callback to communicate with couchdb
    var stdin = process.openStdin();
    stdin.on('data', function(d) {});

    stdin.on('end', function () {
      process.exit(0);
    });

    // Create http server on 5995
    http.createServer(parse_req).listen(5995);  
    log('Datamanager server running on port 5995');
}

main();
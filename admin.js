/*
sys admin function
Can be used with a proxy server or as a couchdb external
*/

var couchdb = require('plantnet-node-couchdb'),
    iniparser = require('iniparser'),
    url = require('url');

var client, respond, error, action_map;


// Validation functions

function valid_action_role(roles, action) {
    return roles.indexOf(action + 'db') >= 0 || roles.indexOf('_admin') >= 0;
}
    
function valid_db_name(param, action) {
    return !!param && param.slice(0,1) != '_';
}

function isDbAdmin(dbName, user, user_roles) {
    return user_roles.indexOf(dbName + '.admin') >=0 || user_roles.indexOf('_admin') >=0;
}

function isDbMember(dbName, user, user_roles) {
    dbName = dbName + '.';
    for (var i = 0; i < user_roles.length; i++) {
        var r = user_roles[i];
        if (r.slice(0, dbName.length) === dbName || r === '_admin') {
            return true;
        }
    }
    return false;
}


// Handlers

// return active task for a db
exports.getActiveTasks = function (srcDb, user, userRoles, query) {
    if (!isDbMember(srcDb, user, userRoles)) {
        error('not a db member');
    } else {
        client.activeTasks(
            function (err, data) {
                if (err) {
                    error(err); return;
                }
                data = data || [];
                
                data = data.filter(function (e) {
                    if(e.database && e.database === srcDb) {
                        e.details = 'db indexation';
                        return true;
                    }
                    
                    if (e.type === 'replication' && (e.source === srcDb || e.target === srcDb)) {
                        
                        var otherDb = e.source === srcDb ? e.target : e.source;
                        otherDb = url.parse(otherDb).pathname;
                        e.details = 'synchronisation with ' + otherDb;
                        return true;
                    }
                    return false;
                });
                
                data = data.map(function (e) {
                    return {
                        type: e.type,
                        details: e.details,
                        progress: e.progress
                    };
                });
               
                respond(data);
            }
        );
    }
};

exports.setPublicDb = function (srcDb, user, user_roles, query) {
    var isPublic = query['public'] === 'true' || query['public'] === true;
    
    var rigths = {
        admins: {
            names: [],
            roles: [srcDb + '.admin']
        },
        members: {
            names: [],
            roles: isPublic ? [] : [srcDb + '.writer', srcDb + '.reader']
        }};

    var db = client.db(srcDb);
    db.saveDoc(
        '_security', 
        rigths, 
        function() {
            respond({
                status: 'ok',
                action: 'set_public',
                src_db: srcDb,
                'public': isPublic
            });
        });
};

exports.createDb = function (srcDb, userName, userRoles, query){
    var dstDb = query.db_name;
    if (!dstDb || !valid_db_name(dstDb, 'create')) {
        error({error: 'invalid db name'});
        return;
    }
    dstDb = dstDb.trim();

    if (!valid_action_role(userRoles, 'create')) {
        error({error: 'invalid role', user: userName, roles: userRoles});
        return;
    }

    var app_doc = '_design/datamanager';

    client.db(dstDb).create(function (err, data) {
        
        if (err) { error(err); return false; }
        if (!srcDb || srcDb === dstDb) { srcDb = "datamanager"; }
        
        client.replicate(
            srcDb, 
            dstDb, 
            { doc_ids: [app_doc]}, 

            function(err, data) {
                if (err) {
                    err.src_db = srcDb;
                    err.dst_db = dstDb;
                    error(err);
                } else {
                    var db = client.db(dstDb),
                    dbName = dstDb,
                    rights = {
                        admins: {
                            names: [],
                            roles: [dbName + '.admin']
                        },
                        members: {
                            names: [],
                            roles: [dbName + '.writer', dbName + '.reader']
                        }
                    };
                db.saveDoc(
                    '_security', 
                    rights, 
                    function() {
                        
                        if(userName) {
                            setDbAdmin(
                                dstDb, 
                                userName, 
                                function() {
                                    
                                }
                            );
                        }
                        
                        respond({
                            status: 'ok',
                            action: 'create',
                            src_db: srcDb,
                            dst_db: dstDb
                        });
                    }
                );
                }
            });
    });
};


// return a list of user
exports.getUserAllDocs = function () {
    var userDb = client.db('_users');
    userDb.allDocs({
            startkey: 'org.couchdb.user:',
            endkey: 'org.couchdb.user:\ufff0',
            include_docs: true
        },
        function(err, data) {
            if (err) {
                error(err);
            } else {
                respond(data);
            }
        }); 
};

//set admin role for user for srcDb
function setDbAdmin(dbName, userName, cb) {
    var userDb = client.db('_users'),
    newrole = dbName + '.admin';
    
    userDb.getDoc(
        'org.couchdb.user:' + userName, 
        function(err, data) {
            if (err) { error(err); return; } 
            if (data.roles.indexOf(newrole) < 0) {
                data.roles.push(newrole);
                userDb.saveDoc(
                    data, 
                    function(err, data) {
                        if (err) { error(err); return; } 
                        cb();
                    }
                );
            } else {
                cb();
            }
        }
    );
};

/*
- port: port
- host: server to reach
- db: database on remote server
- username: username on this server
- password: password on this server
- action: server action to call
- params: parameters for remote action
*/
exports.callRemoteAction = function(srcDb, userName, userRoles, query) {

    var port = query.port || 5984,
        host = query.host,
        db = query.db,
        username = query.username,
        password = query.password,
        remoteAction = query.remoteAction,
        params = {};

    // parse parameters to object
    if (query.params) {
        params = JSON.parse(query.params);
    }

    var remote;
    try {
        remote = couchdb.createClient(port, host, username, password);
    } catch (Exception) {
        error('Error connecting to remote host;');
    }

    var url = '/_dm/' + db + '/' + remoteAction;
    /*respond({ // debug
        status: 'ok',
        action: 'call_remote',
        requestedUrl: url,
        params: params
    });*/

    remote.request(url, params, function(err, data) {
        if (err) {
            error('Error calling remote action: ' + JSON.stringify(err));
        }
        respond({
            status: 'ok',
            action: 'call_remote',
            requestedUrl: url,
            params: params,
            data: data
        });
    });
};

exports.dropDb = function (srcDb, userName, userRoles, query) {
    var dbToRemove = query.db_name;
    dbToRemove = dbToRemove.trim();
    
    if (!dbToRemove || !valid_db_name(dbToRemove, 'drop')) {
        error({error: 'invalid db name'});
    } else if (!valid_action_role(userRoles, 'drop')) {
        error({error: 'invalid role', user: userName, roles: roles});
    } else if (isDbAdmin(dbToRemove, userName, userRoles)) {
        var db = client.db(dbToRemove).remove(
            function(err) {
                // @TODO if err, do something!
                var rolesToClean = [dbToRemove + '.admin', dbToRemove + '.writer', dbToRemove + '.reader'];
                cleanRoles(srcDb, rolesToClean);
                respond({
                    status: 'ok',
                    action: 'drop',
                    src_db: srcDb,
                    dst_db: dbToRemove
                });
            });
    } else {
        error({error: 'user is not a db admin', user: userName, roles: userRoles});
    }
};

// http://localhost:5984/dbName/_admin_db?action=set_roles&roles={user1 : [role1, role2], user2 : [role1, role2]}
exports.setRoles = function (srcDb, userName, userRoles, query) {
    if (!isDbAdmin(srcDb, userName, userRoles)) {
        error({error: 'user is not a db admin', user: userName, roles: userRoles});
        return;
    }

    var roles = query.roles;
    try {
        roles = JSON.parse(roles);
    } catch (x) {
        error({error: 'invalid roles param : ' + x + ' ' + roles});
    }

    var userDb = client.db('_users');

    // get user to edit
    var userkeys = []; 
    for (var u in roles) {
        userkeys.push('org.couchdb.user:' + u);
    }
   
    // get all user docs
    userDb.allDocs({
        include_docs: true,
        keys: userkeys,
    }, function(err, data) {
            if (err) {
                error(err);
            } else {
                var newDocs = [];
                data.rows.forEach(
                    function(e) {
                        var userDoc = e.doc,
                        userRoles = roles[userDoc.name];
                        if (userRoles) {
                            userRoles.forEach(
                                function(e) {
                                    var dbNameRole = e.substring(0, e.indexOf('.', 0)), // dbname
                                        roleSuffix = e.slice(dbNameRole.length + 1),
                                        haveRole = (userDoc && userDoc.roles.indexOf(e) >= 0);

                                    // we can have only one dbname.role in role
                                    if (!haveRole) {
                                        // for each existing role
                                        for (var roleIdx = 0; roleIdx < userDoc.roles.length; roleIdx++) {
                                            var role = userDoc.roles[roleIdx];
                                            // we remove the role with the same dbname
                                            if (role.indexOf(dbNameRole) == 0) { 
                                                userDoc.roles.splice(roleIdx, 1);
                                            }
                                        }
                                        if (roleSuffix != 'exclude') {
                                            userDoc.roles.push(e);
                                        }
                                    }
                                });
                            newDocs.push(userDoc);
                        }
                    }
                ); // end for each
                userDb.bulkDocs(
                    {docs : newDocs}, 
                    function () {
                        respond({
                            status: 'ok',
                            action: 'set_roles',
                            src_db: srcDb,
                            roles: roles 
                        });
                    }
                );
            }
        }
    );
};

// remove roles
function cleanRoles(srcDb, rolesToClean) {
    var userDb = client.db('_users');
    userDb.allDocs(// get all user docs
        {include_docs: true}, 
        function(err, data) {
            if (err) {
                error(err);
            } else {
                var newDocs = [];
                data.rows.forEach(
                    function(e) {
                        var userDoc = e.doc,
                        userRoles = userDoc.roles;
                        if (userRoles) {
                            rolesToClean.forEach(
                                function(role) {
                                    var roleIdx = userRoles.indexOf(role);
                                    
                                    if (roleIdx >= 0) {
                                        userDoc.roles.splice(roleIdx, 1);
                                    }
                                });
                            newDocs.push(userDoc);
                        }
                    }
                ); // end for each
                userDb.bulkDocs({docs: newDocs});
            }
        }
    );
}

exports.process_query = function (action, srcDb, userName, userRoles, query) {
    

    var handler = actionMap[action];
    if (!handler) {
        error("unknown action"); return;
    }

    handler(srcDb, userName, userRoles, query);
}

// return couchdb client
exports.init = function (respond_func, error_func) {

    respond = respond_func;
    error = error_func;

    actionMap = {
        create : exports.createDb,
        drop : exports.dropDb,
        set_roles : exports.setRoles,
        active_tasks : exports.getActiveTasks,
        user_docs : exports.getUserAllDocs,
        set_public : exports.setPublicDb,
        call_remote: exports.callRemoteAction
    };

    try {
        // get config
        var config = iniparser.parseSync(__dirname + '/admin_db.ini');
        client = couchdb.createClient(config.port, config.host, config.login, config.password);
    } catch (Exception) {}

    if (!client) {
        try {
            // get config
            var config = iniparser.parseSync('/opt/datamanager/dm-admin.ini');
            client = couchdb.createClient(config.port, config.host, config.login, config.password);
        } catch (Exception) {}
    }

    // try default port
    if (!client) {
        client = couchdb.createClient("5984", "localhost");
    }

    return client;
};
module.exports = function(RED) {
    "use strict";
    var request = require("request");
    var querystring = require("querystring");
    var CronJob = require('cron').CronJob;


    


    function MonzoCredentialsNode(n) {
       
        RED.nodes.createNode(this, n);
      
        this.cronjob = null;
        var node = this;

        this.cronjob = new CronJob('1 */60 * * * *', function() {

            const Monzo = require('monzo-js');
            var creds = RED.nodes.getCredentials(node.id);
            var secret = creds.secret;
            var clientid = creds.client_id;
            var refreshtoken = creds.refreshtoken;

            if(refreshtoken != ""){

                console.log("monzo - refreshing token");

                Monzo.OAuth.refreshToken(clientid, secret, refreshtoken).then(({access_token, refresh_token}) => {
                    
                    if(access_token){
                        console.log("monzo - refresh complete");
                        var credentials = {
                                client_id:clientid,
                                secret:secret,
                                token:access_token,
                                refreshtoken:refresh_token
                        };

                        RED.nodes.addCredentials(node.id,credentials);
                    }


                }).catch(error => {
                        console.log("monzo - refresh failed, needs reauthenticating");
                });


            } else {
                //no refresh token dont bother trying to refresh it.
            }


        }, null, true, 'America/Los_Angeles');


    }


    MonzoCredentialsNode.prototype.close = function() {
            this.cronjob.stop();
            delete this.cronjob;
    };


    RED.nodes.registerType("monzo-credentials", MonzoCredentialsNode, {
        credentials: {
            client_id: {
                type: "text"
            },
            secret: {
                type: "text"
            },
            token: {
                type: "text"
            },
            refreshtoken: {
                type: "text"
            }
        }
    });


   
    RED.httpAdmin.get('/monzo-creds-set', function(req, res) {

            var secret = req.query.secret;
            var clientid = req.query.clientid;
            var nodeid = req.query.nodeid;
            if(secret != "" && clientid != "" && nodeid != ""){
                var credentials = {
                    client_id:clientid,
                    secret:secret,
                };

                RED.nodes.addCredentials(nodeid, credentials);

                res.send("success");
            } else {
                res.send("fail");
            }

    });

    //set up endpoint for monzo to redirect back to.   
    RED.httpAdmin.get('/monzo-creds', function(req, res) {
            
            //upon redirecting get the auth token and post to monzo to get the refresh token and the access_token
            var credential_node_id = req.query.state;

            var monzocreds = RED.nodes.getCredentials(credential_node_id);

            var opts = {};
            opts.url = "https://api.monzo.com/oauth2/token";
            opts.timeout = 2000;
            opts.method = "POST";
            opts.headers = {};
            opts.maxRedirects = 21;

            var protocol = "";
            if(req.connection.encrypted){
                protocol = "https";
            } else {
                protocol = "http";
            }

            var auth_token = req.query.code;
            var postvars = {
                grant_type:"authorization_code",
                client_id:monzocreds.client_id,
                client_secret:monzocreds.secret,
                redirect_uri:protocol+"://"+req.get('host')+"/monzo-creds",
                code:auth_token
            }
            opts.form = postvars;

            request(opts, function(err, ress, body) {
                if(err){
                    //console.log(err)
                    res.send(err);
     
                }else{
                    //console.log(body);
                    var bodyObject = JSON.parse(body);
                    //var monzocredentialConfig = RED.nodes.getNode(credential_node_id);
                    //monzocredentialConfig.credentials.token = bodyObject.access_token;
                    var additional_text = "";
                    if(bodyObject.refresh_token){
                        
                        additional_text = "<br>This API client has Confidential set to True, because of this, your access_token will automatically refresh itself.";

                    } else {
                        console.log('no refresh token');
                        additional_text = "<br>This token will expire and you will need to manually refresh it. This is because your Monzo API client is set to (Not Confidential).";
                    }

                    if(bodyObject.access_token){
                        var credentials = {
                            client_id:monzocreds.client_id,
                            secret:monzocreds.secret,
                            token:bodyObject.access_token,
                            refreshtoken:bodyObject.refresh_token
                        };

                        RED.nodes.addCredentials(credential_node_id,credentials);
                        res.send("<center><h1>You have successfully authenticated.</h1><h3>Please return to your node-red flow and close this tab/window, you will see that the 'access_token' is now filled in.</h3>"+additional_text+"</center>");
                    } else {
                        //something went wrong, show error.
                        res.send(body);
                    }

                }
            });

            
    });







    function MonzoNodeIn(config) {
        RED.nodes.createNode(this, config);
        this.requesttype = config.requesttype;
        this.monzoConfig = RED.nodes.getNode(config.monzocreds);
        const Monzo = require('monzo-js');


        var node = this;

        if (!this.monzoConfig) {
            this.status({
                fill: "red",
                shape: "dot",
                text: "no token"
            });
        } else {
            this.status({
                fill: "green",
                shape: "dot",
                text: "ready"
            });
        }


      
        node.on('input', function(msg) {

            this.monzoConfig = RED.nodes.getNode(config.monzocreds);

            var monzocredentials = RED.nodes.getCredentials(config.monzocreds);


            this.status({
                fill: "yellow",
                shape: "dot",
                text: "requesting"
            });


            if (!this.monzoConfig) {

                this.status({
                    fill: "red",
                    shape: "dot",
                    text: "no token"
                });
                node.error("you have not entered a token", msg);

            } else {


                const monzo = new Monzo(monzocredentials.token);

                if (this.requesttype == "accounts") {
                    monzo.accounts.all().then(accounts => {
                        for (const [id, acc] of accounts) {
                            msg.payload = {
                                "response": acc._account
                            };
                            node.send(msg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                        }
                    }).catch(error => {
                        node.error("your token is not authenticated.", msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }

                if (this.requesttype == "balances") {
                    monzo.accounts.all().then(accounts => {
                        for (const [id, acc] of accounts) {
                            msg.payload = {
                                "response": acc._balance._balance
                            };
                            node.send(msg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                        }
                    }).catch(error => {
                        node.error("your token is not authenticated.", msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }

                if (this.requesttype == "pots") {
                    monzo.pots.all().then(pots => {
                        for (const [id, pot] of pots) {
                            msg.payload = {
                                "response": {
                                    "pot_name": pot.name,
                                    "pot_balance": pot.balance
                                }
                            };
                            node.send(msg);
                            this.status({
                                fill: "green",
                                shape: "dot",
                                text: "ready"
                            });
                        }
                    }).catch(error => {
                        node.error("your token is not authenticated.", msg);
                        this.status({
                            fill: "red",
                            shape: "dot",
                            text: "no auth"
                        });
                    });
                }


            }
        });
    }
    RED.nodes.registerType("monzo-in", MonzoNodeIn);
}
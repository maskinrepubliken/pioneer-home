/// <reference path="../pb_data/types.d.ts" />
migrate((app) => {
  const collection = new Collection({
    "createRule": null,
    "deleteRule": null,
    "fields": [
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "text3208210256",
        "max": 0,
        "min": 0,
        "name": "id",
        "pattern": "^[a-z0-9]+$",
        "presentable": false,
        "primaryKey": true,
        "required": true,
        "system": true,
        "type": "text"
      },
      {
        "hidden": false,
        "id": "_clone_TGas",
        "max": null,
        "min": null,
        "name": "temperature",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "hidden": false,
        "id": "_clone_b7X8",
        "max": null,
        "min": null,
        "name": "humidity",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "_clone_4y3C",
        "max": 0,
        "min": 0,
        "name": "detail",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "_clone_d4DZ",
        "max": 0,
        "min": 0,
        "name": "icon",
        "pattern": "",
        "presentable": false,
        "primaryKey": false,
        "required": false,
        "system": false,
        "type": "text"
      },
      {
        "hidden": false,
        "id": "json602410524",
        "maxSize": 1,
        "name": "when",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "json"
      }
    ],
    "id": "pbc_2118985887",
    "indexes": [],
    "listRule": null,
    "name": "latestweather",
    "system": false,
    "type": "view",
    "updateRule": null,
    "viewQuery": "select id, temperature, humidity, detail, icon, max(\"when\") as \"when\"\nfrom weather",
    "viewRule": null
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_2118985887");

  return app.delete(collection);
})

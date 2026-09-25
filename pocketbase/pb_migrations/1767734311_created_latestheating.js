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
        "id": "_clone_f3Mi",
        "max": null,
        "min": null,
        "name": "current",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "hidden": false,
        "id": "_clone_prBR",
        "max": null,
        "min": null,
        "name": "target",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "hidden": false,
        "id": "_clone_8qnM",
        "name": "heating",
        "presentable": false,
        "required": false,
        "system": false,
        "type": "bool"
      },
      {
        "hidden": false,
        "id": "_clone_3wP9",
        "max": null,
        "min": null,
        "name": "pi",
        "onlyInt": false,
        "presentable": false,
        "required": false,
        "system": false,
        "type": "number"
      },
      {
        "autogeneratePattern": "",
        "hidden": false,
        "id": "_clone_xZoi",
        "max": 0,
        "min": 0,
        "name": "sensor",
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
    "id": "pbc_1613796271",
    "indexes": [],
    "listRule": null,
    "name": "latestheating",
    "system": false,
    "type": "view",
    "updateRule": null,
    "viewQuery": "select id, current, target, heating, pi, sensor, max(\"when\") as \"when\"\nfrom heating\ngroup by sensor",
    "viewRule": null
  });

  return app.save(collection);
}, (app) => {
  const collection = app.findCollectionByNameOrId("pbc_1613796271");

  return app.delete(collection);
})

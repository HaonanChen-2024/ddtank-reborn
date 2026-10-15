// Minimal original bitmap/style closure. No network or whole Wonderful module is loaded.
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {inflateRawSync} from 'node:zlib';
import {zipRecords} from '../workshop-bag-layout.mjs';
import {scan,pinned,sha} from '../native-pair/build-library.mjs';
export const exchangeBitmapRows=[
 {
  "symbol": "asset.core.btmc003",
  "alias": "workshop.exchange.skin.Skin01",
  "id": 1,
  "originalId": 157,
  "source": "runtime/reference-activities-completion-20261014/magicwardrobe-native-candidate/corei_v3_6_1_u2.swf",
  "sourceSha256": "e2adaaccc5eb032be39142c2784c234506da4f2f571bfadde421813ae3aa4310",
  "tagCode": 35,
  "tagSha256": "7b525832124f6b8f1d9acd809ff6e261c5ae02687dfda06d1d74fd7defac7e58",
  "payloadSha256": "4e0431563cb855d94df8b00abf191a4fb7c0e4bcbabefedbce600961fb87abcc"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.1",
  "alias": "workshop.exchange.skin.Skin02",
  "id": 2,
  "originalId": 204,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "1c13bd212c6d4bffd75fddd93ef7027d19864d347466242cd6c48d854b3b5afe",
  "payloadSha256": "ccab8f3826803c0bf465ba400b6b04ed67798786f3136d2c9c2128bb7ec9070e"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.2",
  "alias": "workshop.exchange.skin.Skin03",
  "id": 3,
  "originalId": 22,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 21,
  "tagSha256": "3fa60c0226811d82e5fbc996c5bc55227617b2ee549e10c1fb09af0c30823f2c",
  "payloadSha256": "f9fde5ec869c6e139420e590c9bc8ad0626057d8deaff2636d8970c15bcfec97"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.3",
  "alias": "workshop.exchange.skin.Skin04",
  "id": 4,
  "originalId": 215,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "47f17a131877e2db7e4a6ffc32c99f64aedd11834621462504525faa2f27e344",
  "payloadSha256": "d398c0dd6ebe2f1b48f46fe6a9fad65ca217cc0b8e3cca42c863ce1506bf9ba2"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.4",
  "alias": "workshop.exchange.skin.Skin05",
  "id": 5,
  "originalId": 259,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 21,
  "tagSha256": "35895d12be3e2bf951279c2ec22d6cd86546df96e4af04bb40ee081c29df9a52",
  "payloadSha256": "407792f4aa47b1442813278dd4d6535dde536890ce8c549cf2fa3db7e8d8531e"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.5",
  "alias": "workshop.exchange.skin.Skin06",
  "id": 6,
  "originalId": 21,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 21,
  "tagSha256": "f7956550b4ecc6f7a034ffb2a4a90dbb937df8d5d8aedf0d168600fa5a2d423f",
  "payloadSha256": "e208e50e4c1d805b08cc62252f9a440bbd6abacecdc1909ac266a0cd9b6beb0c"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.6",
  "alias": "workshop.exchange.skin.Skin07",
  "id": 7,
  "originalId": 33,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "4b621684b46aa482732fbe6263152adc7dc39bf9a884fc6c8b67b3ad8f4fdedc",
  "payloadSha256": "d88a05f6531fa5a9f9d42448ee7e722fcbbf2d73209966cf12d4409b278621ba"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.7",
  "alias": "workshop.exchange.skin.Skin08",
  "id": 8,
  "originalId": 237,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "6389c6446e76cdbad14c6d92b85a424ec7b0542f597f7678b30960c667a6acea",
  "payloadSha256": "b3cc35ba9fde847665c4c28807d57e005852e8504a8bc9855b341df42f084a4d"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.8",
  "alias": "workshop.exchange.skin.Skin09",
  "id": 9,
  "originalId": 44,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 21,
  "tagSha256": "63230485ac94c5a2f0c5458cf1fa44d5ac0bc0e4a2bbe4352818e54de4f5c175",
  "payloadSha256": "957db411d46d203d1576bfce916f65120baac0aba70cbc6035deae898c6eab49"
 },
 {
  "symbol": "asset.core.ddtScale9CornerImage12.9",
  "alias": "workshop.exchange.skin.Skin10",
  "id": 10,
  "originalId": 226,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "fd38549b16bfc664748485fb579c07aa7ad989dc45c2fe1c0795c3a63e777303",
  "payloadSha256": "b2bcf4a7ee7586596ec65fd6b4dac6e6a9eb16ddada933f75127149825c4b503"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.1",
  "alias": "workshop.exchange.skin.Skin11",
  "id": 11,
  "originalId": 125,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "e5ab4069594ad0624323ec4e041281f8f9d60836d3d760cb271071599db11ef4",
  "payloadSha256": "0aa3491295431d910d781ef5db29526af7d9cfe5d1b9fea291663b684cab5fc2"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.2",
  "alias": "workshop.exchange.skin.Skin12",
  "id": 12,
  "originalId": 156,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "85cc49a35620e06d29201fe9a6dec827b3d5abf020a68c28e95e81bb2e6eecb6",
  "payloadSha256": "e8e4cbbb28f3c447c3dfa1f1009bd55c563b47e6bc789b5613f588742bb11450"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.3",
  "alias": "workshop.exchange.skin.Skin13",
  "id": 13,
  "originalId": 173,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "7a0d0b2ee3cc93d9f932ba1a0c56236b14d25122e77cabf81303b568ab9e8317",
  "payloadSha256": "a29ffeab8c0cb6c584b06ce24417337bb645d603d1342f2cf7767df1fa25d89a"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.4",
  "alias": "workshop.exchange.skin.Skin14",
  "id": 14,
  "originalId": 189,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "47d8935831edf2aa72c3666ccf921fa392717d024b14c12c89a4ecfb8bed808a",
  "payloadSha256": "13334f48869a1a744ef754e259064b834544b6ad6358670bc68cfc5c3f94d933"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.5",
  "alias": "workshop.exchange.skin.Skin15",
  "id": 15,
  "originalId": 198,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "04ea76f68cf2d4df9b0ec706310c5eb280985c790e06099e080c56256f9bbe16",
  "payloadSha256": "4ee0ffb449e2586ad7d3398f5fa6ca769f32c1c716fb65d4bcc0560a121b2fef"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.6",
  "alias": "workshop.exchange.skin.Skin16",
  "id": 16,
  "originalId": 205,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "af0589f825350648f3662a253962ab5d174b70515e228492b514aa64268fa371",
  "payloadSha256": "db9697cfa1aebb24d41215acfe02618b3f3bb3f3ff5941f48ff1b38b5012fa82"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.7",
  "alias": "workshop.exchange.skin.Skin17",
  "id": 17,
  "originalId": 211,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "1f858ebce54a3df13f99ffc9ee77bd55530f44ef187550ea158e3c3ed3bd8ec2",
  "payloadSha256": "ff496fee07de8651b36e39213e4dd0093cd1f27fdb0fc03ebc9d774ab3dbfdb4"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.8",
  "alias": "workshop.exchange.skin.Skin18",
  "id": 18,
  "originalId": 219,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "8c3fed8e35b563ea2402a78691e7781f51e29820f95a690127053ba3a79ba746",
  "payloadSha256": "c630cb7da370805fc09a12dced50bf33b0b49b75ae16b60f44f8f170efc5f0c9"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage18.9",
  "alias": "workshop.exchange.skin.Skin19",
  "id": 19,
  "originalId": 225,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "2f5e5e5b9aa13a35918ed45404c7d93562857593f1deed6d6c34ab779bd56a3b",
  "payloadSha256": "76195a8398537b0cbd10e315f437f34a550f78e7582897aeaedcb8972195adc0"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.1",
  "alias": "workshop.exchange.skin.Skin20",
  "id": 20,
  "originalId": 260,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "2d8f0bc7de7174c93eb598e02e6c3f1b7bcebbf0651c20713bd91cfbe6725992",
  "payloadSha256": "0fdc58a4bdec1fc9e6cff2dddf73709ff65079d1a298c713b34f448e49ed905a"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.2",
  "alias": "workshop.exchange.skin.Skin21",
  "id": 21,
  "originalId": 149,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "89bc7cc27af0b3f930bd17843fbd0e67484462d94ea2a7fbc6ab8e917e9a5314",
  "payloadSha256": "eb8f9b8e2c7f677e33b3d989efd3891eda1e349434908d3e65fa12967b12c674"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.3",
  "alias": "workshop.exchange.skin.Skin22",
  "id": 22,
  "originalId": 56,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "415dd208582a1844fe72da9fbe752a4bd267b4bf544a4c7413805f79a888f487",
  "payloadSha256": "d703dd0f02c83744ca6a85e6ce1281618c7309f82bb3c8329f4529414618694e"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.4",
  "alias": "workshop.exchange.skin.Skin23",
  "id": 23,
  "originalId": 95,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "eed1298f248171db4f313d57cd717f60cfeec5ab1bb64d8fb55d2cc57b5b8334",
  "payloadSha256": "876fe120c089198d7dda57786c47df528900d8dc002f9fc68345e3a35c1f18d4"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.5",
  "alias": "workshop.exchange.skin.Skin24",
  "id": 24,
  "originalId": 99,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 21,
  "tagSha256": "b7e0571e1c80bbe7307461daf374588d7ace567728c5457d7cb8d44439def37d",
  "payloadSha256": "0a4763a41427470d62b882794e8555f2a95ce1d451cb0f9e63751a7431542ef3"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.6",
  "alias": "workshop.exchange.skin.Skin25",
  "id": 25,
  "originalId": 98,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "94a3caa409e85e1eadfaa6b730702babe7761ad1ba0b4a7fccd951ffccd87477",
  "payloadSha256": "e93bec3d52b83e4c6b341f285e9b93029dfeb7a075f82457684b5c5b06afdbf0"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.7",
  "alias": "workshop.exchange.skin.Skin26",
  "id": 26,
  "originalId": 78,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "60b209aa8b0ce013bf60d8e2305a1cdadab546f1b148bcdbddb06403e8a4c00b",
  "payloadSha256": "aca162f70bf2fa1f6ea002875f7d1010c7c44f6b5b3d3862d0f230e435fc1347"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.8",
  "alias": "workshop.exchange.skin.Skin27",
  "id": 27,
  "originalId": 96,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "3652c8bdd4d1ae7bf91a3889a8497861c70ef392fc823568f81537fb094ec896",
  "payloadSha256": "9b2a7c1067570d4d00eed157e0cbf576908e02fc52de8503a2413415c7cae3b3"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage3.9",
  "alias": "workshop.exchange.skin.Skin28",
  "id": 28,
  "originalId": 67,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "4d411c36b10cf029028af3572ccec35087a801560884587df74310f0d7a6b497",
  "payloadSha256": "4a7fd2971f878450af4579a020607fa3d7cf6c9f8b09c73041ffc172c686fbac"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.1",
  "alias": "workshop.exchange.skin.Skin29",
  "id": 29,
  "originalId": 48,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "a372b9d910837f2d4abb411c8c9e22e3918bf53e9ef490f491410b4b2b71f3f0",
  "payloadSha256": "6e4342eb1a7d365dd16f6031a5a36812894d3005f297a0d1e9962de585732f3f"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.2",
  "alias": "workshop.exchange.skin.Skin30",
  "id": 30,
  "originalId": 51,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "5c2da0998e79b43d464a644cfd8b593a75ae1bdf566e417328cc6ea9cd6c09b9",
  "payloadSha256": "ddb90ea71e35b1f2f2213b4664cf124ce48861c5f39ec912d7ab2af8eabe3076"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.3",
  "alias": "workshop.exchange.skin.Skin31",
  "id": 31,
  "originalId": 52,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "c8809dd7fa397c9f93b5abb15a512ecc874ad0a2609029491d662686eb528fff",
  "payloadSha256": "6a4394f7048c244cdc41ec80a1047581e8f2d8211d580cd9e58805303dddf78c"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.4",
  "alias": "workshop.exchange.skin.Skin32",
  "id": 32,
  "originalId": 53,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "684f5f23c6f6babcdf58afc5f048098345bf53947a5251696acfe9d38a1afa65",
  "payloadSha256": "600d5ebda0e1532b2ca04ed8794d1d997fe3c920f8a8dc30900cacde908cdeec"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.5",
  "alias": "workshop.exchange.skin.Skin33",
  "id": 33,
  "originalId": 54,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "36de3e598bbcf81b771da4e5475fd9b7f71bf5a1769c03b37d5bcba5c23e840b",
  "payloadSha256": "b3766b4b32513aa417f1b313ae33622d0c67d485cd4cbcd9e4ceb092ca213cf7"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.6",
  "alias": "workshop.exchange.skin.Skin34",
  "id": 34,
  "originalId": 55,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "10195ad4c38b40213a1e63704cb440df433789dc25a4b425678b2e2e85553b13",
  "payloadSha256": "e9a96aaa0025687780f4dc568115b9dc269d55daecd273650232d4ddd1fe0f11"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.7",
  "alias": "workshop.exchange.skin.Skin35",
  "id": 35,
  "originalId": 58,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "62bac18759fa241e462495e3270d7d209a2b134be10d5e42f1e22b12fec0e653",
  "payloadSha256": "ac59d1f19e0c908ae6b8a411bcf089854d2c1829500029d20b23a31d7338617e"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.8",
  "alias": "workshop.exchange.skin.Skin36",
  "id": 36,
  "originalId": 59,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "1b1858953b65fc12420ca9c088aa806caaad3f4a51ea9757c28f3ad0ec342f58",
  "payloadSha256": "5b266addf314d04700aec43ff455e60eb50efd9273f701bc7c06186cc4658df3"
 },
 {
  "symbol": "asset.core.NewScale9CornerImage6.9",
  "alias": "workshop.exchange.skin.Skin37",
  "id": 37,
  "originalId": 60,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "f85c499759c2b2fe2656ce343a011befcec048a0127c414042f159fa992ef9fe",
  "payloadSha256": "d656626f8da32451957c59f9be863fa663f734cff2964dd21b60753b40601db4"
 },
 {
  "symbol": "asset.core.ScaleBitmapImage2",
  "alias": "workshop.exchange.skin.Skin38",
  "id": 38,
  "originalId": 148,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "2d7aafb4c7ae7427a968a99ca8ae63b1831c336c418362fe0457d1e7344e11b9",
  "payloadSha256": "533370e747d5b5b66398f82cde8a68d2e42a824a6ee153ab9af7d80c1870d19d"
 },
 {
  "symbol": "asset.ddtcalendar.ActivityState.AwardIcon",
  "alias": "workshop.exchange.skin.Skin39",
  "id": 39,
  "originalId": 46,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "a48e2d214f43f7c01baa982a268f6414740a3af57cc492048dd2b9d37b7c5797",
  "payloadSha256": "c59dbdf8925d5b89bbee5a13c307a186af57bbb6c63825e8496d0a3ec83165ce"
 },
 {
  "symbol": "asset.ddtcalendar.ActivityState.ContentIcon",
  "alias": "workshop.exchange.skin.Skin40",
  "id": 40,
  "originalId": 40,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "1c448b220b11b7a593ef3c953e6f15ad9df97c0718f5578ffa38ef6aed42acba",
  "payloadSha256": "6432c4167919c88698fb1de16d7de7b06b1f9fdf4986f723a1749fa3fc154dc4"
 },
 {
  "symbol": "asset.ddtcalendar.ActivityState.exChangeButtonBg",
  "alias": "workshop.exchange.skin.Skin41",
  "id": 41,
  "originalId": 17,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 35,
  "tagSha256": "b2f380cd23a2d5c30dcaf174db4255d35d07c8d372e18aa89f7c32c2997c5e6a",
  "payloadSha256": "df27d94b847999456a8bbd65be349c7524706807addf4b2e49f0b6027d422c8d"
 },
 {
  "symbol": "asset.ddtcalendar.ActivityState.SeparatorLine",
  "alias": "workshop.exchange.skin.Skin42",
  "id": 42,
  "originalId": 35,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "ac794a738b1d808a69b14345e91a1e2ac0ba577dd379ce0c989b4375e6685afb",
  "payloadSha256": "ed5cb2f9904de25d45180dcd8a556074e78f2bc00012ff70333137603e75cc85"
 },
 {
  "symbol": "asset.ddtcalendar.ActivityState.TimeIcon",
  "alias": "workshop.exchange.skin.Skin43",
  "id": 43,
  "originalId": 30,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "eff77c608648990045ed3c9b9a8a756d66a69b4a97e9e6e7f17ae119daa8b5a4",
  "payloadSha256": "8a98e669cec3c8c7b755646738a27e4ae7975a5b0b2ef454ff250d30f4140891"
 },
 {
  "symbol": "asset.ddtcalendar.ActivityStateTitleBg",
  "alias": "workshop.exchange.skin.Skin44",
  "id": 44,
  "originalId": 47,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 35,
  "tagSha256": "419f4c7abeb0b89585af3a6f9a029b550b31e856debc5cd19eaef13d9c986ba7",
  "payloadSha256": "beff359f7c4f02e7b715be625dbaa9fc6651a672c02dd50bceba222e97ef9aa6"
 },
 {
  "symbol": "asset.vein.fur",
  "alias": "workshop.exchange.skin.Skin45",
  "id": 45,
  "originalId": 154,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "c1cb224bd216f8d7fb638d52783af6114969dcd779c9c2e9261412b68cc9e95a",
  "payloadSha256": "cf64fab49ee5a699da670583b0ea4acd12965bb6e3e693056bdfc78a95ba3fd1"
 },
 {
  "symbol": "asset.vein.paper",
  "alias": "workshop.exchange.skin.Skin46",
  "id": 46,
  "originalId": 236,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 35,
  "tagSha256": "780a01af8cf50514b38ac3b41d0fb64328f459c5f8f15b8f121a6debd756fc8e",
  "payloadSha256": "5b6a19dd3a4a630d05173306f1d07c0240adfe2f562746e3cbc347dcc56c41f3"
 },
 {
  "symbol": "ddtcalendar.exchange.cellBg",
  "alias": "workshop.exchange.skin.Skin47",
  "id": 47,
  "originalId": 21,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "c8f1382f1ea9013207211d6f60df82364e7d27b4fa0a6a4af52cc0ec8ba85378",
  "payloadSha256": "df98164c0bc2559950c2d36a93b17193c2e52d52e10920aff032b265298d79e3"
 },
 {
  "symbol": "ddtcalendar.GoodsExchangeView.awardBtn1Asset",
  "alias": "workshop.exchange.skin.Skin48",
  "id": 48,
  "originalId": 13,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 35,
  "tagSha256": "391cd05728a981c7bfb19c391af9a570bb40fc66ee5668e6458049e3e865f519",
  "payloadSha256": "96cd5b14518d51d105e9e7f9240859045bc1df4efadf635340702b0c06fbac5e"
 },
 {
  "symbol": "ddtcalendar.GoodsExchangeView.awardBtn2Asset",
  "alias": "workshop.exchange.skin.Skin49",
  "id": 49,
  "originalId": 12,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 35,
  "tagSha256": "228fae33a1559fdc468b13c23df208c82536dee48b6853a7484f51fd5dff9084",
  "payloadSha256": "33773322b64de8d8d1cc9aab303c8eea551ca563cce8e4e414e04c841f9a2a24"
 },
 {
  "symbol": "ddtcalendar.GoodsExchangeView.awardBtn3Asset",
  "alias": "workshop.exchange.skin.Skin50",
  "id": 50,
  "originalId": 11,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 35,
  "tagSha256": "ed66c68415d9d63ffff72737451b9baaded1d4f600b2202977e31a141643c74f",
  "payloadSha256": "b3154152d2e48177042022cd2675513318cd057f7990f9baf1a1f434f8d229f4"
 },
 {
  "symbol": "ddtcalendar.GoodsExchangeView.awardBtn4Asset",
  "alias": "workshop.exchange.skin.Skin51",
  "id": 51,
  "originalId": 10,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 35,
  "tagSha256": "533031d4b6a74558988abbaa4c957e3125360321d7e0e62421c4b96bfbe232ec",
  "payloadSha256": "a2931627ce0b6dc9f22ee7ea32672c5a2543271614780179f213e17d4310bd89"
 },
 {
  "symbol": "ddtcalendar.GoodsExchangeView.selectedAsset",
  "alias": "workshop.exchange.skin.Skin52",
  "id": 52,
  "originalId": 8,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "5193a35aee247c12b34811f170cf341e6e02a981d2afa1169b05d5dd879c8d00",
  "payloadSha256": "ef56ecc5a1fb573a3b5d4cdb22f733a60ea7e3394170bb83d3f82ffe06872afb"
 },
 {
  "symbol": "ddtcalendar.GoodsExchangeView.unselectedAsset",
  "alias": "workshop.exchange.skin.Skin53",
  "id": 53,
  "originalId": 9,
  "source": "runtime/reference-activities-completion-20261014/native-wonderful-readonly-20261015/public-calendar-art-a/ddtcalendar_v3_6_1_u1.swf",
  "sourceSha256": "68ab9679373018e9718dc90e14b407e01f8493bc7c73154865741f3258b8d7f4",
  "tagCode": 36,
  "tagSha256": "1023d93c4d9898f0f1a4825210160b98147ab3f8fd48de80a8c1b858cc3633ad",
  "payloadSha256": "540663069751782f28b3c65e3f7520a31073a4b91c066ea77edc3b2e3e38d9b4"
 },
 {
  "symbol": "asset.core.btmBG",
  "alias": "workshop.exchange.skin.Skin54",
  "id": 54,
  "originalId": 238,
  "source": "runtime/reference-activities-completion-20261014/native-ddplay-analysis-20261015/ddtcorescalebitmap_v3_6_1_u2.swf",
  "sourceSha256": "a374fe977c89a74494c3143a4bade0722c1f3113b216563c6ce1efd24282e827",
  "tagCode": 36,
  "tagSha256": "194d317b8ff8adfcc3d16e3aff36d3d590a13139c830b0383820a2c8a7e70a49",
  "payloadSha256": "10968bfca07c087e4c5eba2b270ae9d91fd326f22d76d16062c8bef4a0fd8200"
 }
];
export const exchangeStyleRows=[
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.SimpleBitmapButton",
   "stylename": "ddtcalendar.ActivityState.exchangeButton",
   "backStyle": "ddtcalendar.ActivityState.exchangeButtonBg",
   "x": "182",
   "y": "446"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.ScaleBitmapImage",
   "stylename": "ddtcalendar.ActivityState.GetButtonBackBg",
   "parentStyle": "asset.core.btmBimap",
   "width": "495",
   "height": "58",
   "x": "18",
   "y": "441"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.ActivityStateBg",
   "resourceLink": "core.Scale9CornerImage.Scale9CornerImage18,core.Scale9CornerImage.weilipaper,core.ScaleBitmapImage2,asset.ddtcalendar.ActivityStateTitleBg",
   "imageRectString": "0|500|0|420|13,7|490|7|420|13,7|485|10|400|13,33|430|21|36|13",
   "width": "434",
   "height": "378",
   "x": "16",
   "y": "20"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.ActivityStateTitleField",
   "textFormatStyle": "ddtcalendar.ActivityStateTitleFieldTF",
   "filterString": "ddtcalendar.ActivityStateTitleFieldGF",
   "autoSize": "center",
   "x": "260",
   "y": "51",
   "maxChars": "19"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.container.SimpleTileList",
   "stylename": "ddtcalendar.exchange.exchangeGoodsBox",
   "x": "38",
   "y": "246",
   "hSpace": "8",
   "vSpace": "4"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.container.SimpleTileList",
   "stylename": "ddtcalendar.exchange.haveGoodsBox",
   "x": "87",
   "y": "28",
   "hSpace": "15",
   "vSpace": "4"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "flash.geom.Point",
   "stylename": "ddtcalendar.exchange.LinePos",
   "x": "3",
   "y": "140"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.actTime",
   "textFormatStyle": "ddtcalendar.ActivityState.TimeFieldTF",
   "autoSize": "none",
   "x": "120",
   "y": "4",
   "width": "200",
   "height": "20"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.actTimeText",
   "textFormatStyle": "ddtcalendar.ActivityState.TimeFieldTF",
   "autoSize": "none",
   "x": "41",
   "y": "3",
   "width": "80",
   "height": "20"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBack",
   "resourceLink": "ddtcalendar.GoodsExchangeView.awardBack.BG01,ddtcalendar.GoodsExchangeView.awardBack.BG02",
   "x": "4",
   "y": "172"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.SelectedButton",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn1",
   "filterString": "null,lightFilter,null,grayFilter",
   "unSelectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn1.unselected",
   "selectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn1.selected",
   "x": "19",
   "y": "183",
   "displacement": "false"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.SelectedButton",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn2",
   "filterString": "null,lightFilter,null,grayFilter",
   "unSelectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn2.unselected",
   "selectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn2.selected",
   "x": "111",
   "y": "183",
   "displacement": "false"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.SelectedButton",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn3",
   "filterString": "null,lightFilter,null,grayFilter",
   "unSelectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn3.unselected",
   "selectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn3.selected",
   "x": "202",
   "y": "183",
   "displacement": "false"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.controls.SelectedButton",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn4",
   "filterString": "null,lightFilter,null,grayFilter",
   "unSelectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn4.unselected",
   "selectedStyle": "ddtcalendar.GoodsExchangeView.awardBtn4.selected",
   "x": "293",
   "y": "183",
   "displacement": "false"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.Scale9CornerImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardScoreBg",
   "parentStyle": "core.Scale9CornerImage.scale9CornerImageInputBG",
   "width": "357",
   "height": "86",
   "x": "22",
   "y": "227"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.cellCount",
   "textFormatStyle": "ddtcalendar.ActivityState.cellCountTF",
   "filterString": "ddtcalendar.ActivityState.cellCountGF",
   "autoSize": "none",
   "x": "-1",
   "y": "31",
   "width": "50",
   "height": "20"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.changeGoodsCount",
   "textFormatStyle": "ddtcalendar.GoodsExchangeView.changeGoodsCountTF",
   "filterString": "ddtcalendar.GoodsExchangeView.changeGoodsCountGF",
   "autoSize": "none",
   "type": "input",
   "x": "350",
   "y": "148",
   "width": "40",
   "height": "20"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.changeGoodsCountText",
   "textFormatStyle": "ddtcalendar.ActivityState.TimeFieldTF",
   "autoSize": "none",
   "x": "243",
   "y": "147",
   "width": "105",
   "height": "30"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.changeGoodsExplain",
   "textFormatStyle": "ddtcalendar.ActivityState.TimeFieldTF",
   "autoSize": "none",
   "x": "42",
   "y": "147",
   "width": "100",
   "height": "30"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "flash.geom.Point",
   "stylename": "ddtcalendar.GoodsExchangeView.changeImgPos",
   "x": "0",
   "y": "133"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.text.FilterFrameText",
   "stylename": "ddtcalendar.GoodsExchangeView.haveGoodsExplain",
   "textFormatStyle": "ddtcalendar.ActivityState.TimeFieldTF",
   "autoSize": "none",
   "x": "10",
   "y": "32",
   "width": "336",
   "height": "40"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "flash.geom.Point",
   "stylename": "ddtcalendar.GoodsExchangeView.HaveImgPos",
   "x": "0",
   "y": "20"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.Scale9CornerImage",
   "stylename": "ddtcalendar.GoodsExchangeView.TextFieldBg",
   "parentStyle": "core.Scale9CornerImage.scale9CornerImageInputBG",
   "width": "52",
   "height": "21",
   "x": "344",
   "y": "147"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "flash.geom.Point",
   "stylename": "ddtcalendar.GoodsExchangeView.timeImgPos",
   "x": "0",
   "y": "0"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "flash.geom.Point",
   "stylename": "wonderful.exchangeGoodsView",
   "x": "57",
   "y": "86"
  }
 },
 {
  "tag": "custom",
  "attributes": {
   "classname": "flash.geom.Point",
   "stylename": "wonderful.limitActivity.ContentPos",
   "x": "228",
   "y": "31"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.ActivityState.exchangeButtonBg",
   "resourceLink": "core.bg6899,asset.ddtcalendar.ActivityState.exChangeButtonBg",
   "imageRectString": "0|153|0|49|13,34|85|6|35|13",
   "width": "153",
   "height": "49"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.Scale9CornerImage",
   "stylename": "core.Scale9CornerImage.Scale9CornerImage18",
   "resourceLink": "asset.core.NewScale9CornerImage18.1,asset.core.NewScale9CornerImage18.2,asset.core.NewScale9CornerImage18.3,asset.core.NewScale9CornerImage18.4,asset.core.NewScale9CornerImage18.5,asset.core.NewScale9CornerImage18.6,asset.core.NewScale9CornerImage18.7,asset.core.NewScale9CornerImage18.8,asset.core.NewScale9CornerImage18.9"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.TiledImage",
   "stylename": "core.Scale9CornerImage.weilipaper",
   "resourceLink": "asset.vein.paper"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.ScaleBitmapImage",
   "stylename": "core.ScaleBitmapImage2",
   "resourceLink": "asset.core.ScaleBitmapImage2",
   "scaleGridString": "70,35,95,70"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.ActivityStateTitleFieldTF",
   "args": "宋体,16,0xffe981,true",
   "letterSpacing": "2",
   "type": "flash.text.TextFormat"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.ActivityStateTitleFieldGF",
   "args": "0x5c310e,1,4,4,30",
   "type": "flash.filters.GlowFilter"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.ActivityState.TimeFieldTF",
   "args": "宋体,14,0x942d05,true",
   "type": "flash.text.TextFormat"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBack.BG01",
   "width": "393",
   "height": "156",
   "parentStyle": "core.Scale9CornerImage.BGAsset5",
   "x": "0",
   "y": "1"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBack.BG02",
   "resourceLink": "core.Scale9CornerImage.SimpleTableBackgound2,core.Scale9CornerImage.weilifur",
   "imageRectString": ",5|7|5|5|0",
   "width": "391",
   "height": "154",
   "x": "2",
   "y": "3"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn1.unselected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.unselectedAsset,ddtcalendar.GoodsExchangeView.awardBtn1Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn1.selected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.selectedAsset,ddtcalendar.GoodsExchangeView.awardBtn1Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn2.unselected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.unselectedAsset,ddtcalendar.GoodsExchangeView.awardBtn2Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn2.selected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.selectedAsset,ddtcalendar.GoodsExchangeView.awardBtn2Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn3.unselected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.unselectedAsset,ddtcalendar.GoodsExchangeView.awardBtn3Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn3.selected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.selectedAsset,ddtcalendar.GoodsExchangeView.awardBtn3Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn4.unselected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.unselectedAsset,ddtcalendar.GoodsExchangeView.awardBtn4Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "ddtcalendar.GoodsExchangeView.awardBtn4.selected",
   "resourceLink": "ddtcalendar.GoodsExchangeView.selectedAsset,ddtcalendar.GoodsExchangeView.awardBtn4Asset"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.Scale9CornerImage",
   "stylename": "core.Scale9CornerImage.scale9CornerImageInputBG",
   "resourceLink": "asset.core.NewScale9CornerImage6.1,asset.core.NewScale9CornerImage6.2,asset.core.NewScale9CornerImage6.3,asset.core.NewScale9CornerImage6.4,asset.core.NewScale9CornerImage6.5,asset.core.NewScale9CornerImage6.6,asset.core.NewScale9CornerImage6.7,asset.core.NewScale9CornerImage6.8,asset.core.NewScale9CornerImage6.9"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.ActivityState.cellCountTF",
   "args": "宋体,12,0xffffff,,,,,,right",
   "type": "flash.text.TextFormat"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.ActivityState.cellCountGF",
   "args": "0x1c0303,1,2,2,10",
   "type": "flash.filters.GlowFilter"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.GoodsExchangeView.changeGoodsCountTF",
   "args": "宋体,14,0xffffff,true,,,,,center",
   "type": "flash.text.TextFormat"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "stylename": "ddtcalendar.GoodsExchangeView.changeGoodsCountGF",
   "args": "0x1c0303,1,2,2,10",
   "type": "flash.filters.GlowFilter"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.ScaleBitmapImage",
   "stylename": "core.bg6899",
   "resourceLink": "asset.core.btmc003",
   "scaleGridString": "20,20,75,27"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.MutipleImage",
   "stylename": "core.Scale9CornerImage.BGAsset5",
   "resourceLink": "asset.core.ddtScale9CornerImage12,core.Scale9CornerImage.weilifur",
   "imageRectString": ",2|2|2|2|0"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.Scale9CornerImage",
   "stylename": "core.Scale9CornerImage.SimpleTableBackgound2",
   "resourceLink": "asset.core.NewScale9CornerImage3.1,asset.core.NewScale9CornerImage3.2,asset.core.NewScale9CornerImage3.3,asset.core.NewScale9CornerImage3.4,asset.core.NewScale9CornerImage3.5,asset.core.NewScale9CornerImage3.6,asset.core.NewScale9CornerImage3.7,asset.core.NewScale9CornerImage3.8,asset.core.NewScale9CornerImage3.9"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.TiledImage",
   "stylename": "core.Scale9CornerImage.weilifur",
   "resourceLink": "asset.vein.fur"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.Scale9CornerImage",
   "stylename": "asset.core.ddtScale9CornerImage12",
   "resourceLink": "asset.core.ddtScale9CornerImage12.1,asset.core.ddtScale9CornerImage12.2,asset.core.ddtScale9CornerImage12.3,asset.core.ddtScale9CornerImage12.4,asset.core.ddtScale9CornerImage12.5,asset.core.ddtScale9CornerImage12.6,asset.core.ddtScale9CornerImage12.7,asset.core.ddtScale9CornerImage12.8,asset.core.ddtScale9CornerImage12.9"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "args": "1,0,0,0,25,0,1,0,0,25,0,0,1,0,25,0,0,0,1,0",
   "stylename": "lightFilter",
   "type": "flash.filters.ColorMatrixFilter"
  }
 },
 {
  "tag": "set",
  "attributes": {
   "args": "0.3,0.59,0.11,0,0,0.3,0.59,0.11,0,0,0.3,0.59,0.11,0,0,0,0,0,1,0",
   "stylename": "grayFilter",
   "type": "flash.filters.ColorMatrixFilter"
  }
 },
 {
  "tag": "component",
  "attributes": {
   "classname": "com.pickgliss.ui.image.ScaleBitmapImage",
   "stylename": "asset.core.btmBimap",
   "resourceLink": "asset.core.btmBG",
   "scaleGridString": "14,13,250,22"
  }
 }
];
export const styleAliases=new Map(exchangeStyleRows.map((s,i)=>[s.attributes.stylename,'workshop.exchange.style.S'+String(i+1).padStart(2,'0')]));
export const artAliases=new Map(exchangeBitmapRows.map(s=>[s.symbol,s.alias]));
export function remapExchangeString(s){return styleAliases.get(s)??artAliases.get(s)??s;}
const escape=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
export function exchangeStyles(){return '<style name="workshop-native-exchange" version="1.0.0">'+exchangeStyleRows.map(s=>'<'+s.tag+' '+Object.entries(s.attributes).map(([k,v])=>k+'="'+escape(k==='args'&&s.attributes.type==='flash.text.TextFormat'?v.replace(/Arial|Tahoma|Times New Roman|宋体|SimSun/g,'Microsoft YaHei'):String(v).split(',').map(remapExchangeString).join(','))+'"').join(' ')+'/>').join('')+'</style>';}
function verifyOriginalStyles(projectRoot){const path=resolve(projectRoot,'runtime/reference-activities-completion-20261014/native-mines-resources-20261015/reference-styles-xml_v3_6_1_u5.png'),bytes=pinned(path,'1d1c4fc983ce7d3df36cb16dd1f62a93591aaf0181c67ffcf11764c927c24f33'),originals=zipRecords(bytes).records.flatMap(r=>{const xml=inflateRawSync(bytes.subarray(r.data,r.data+r.compressedSize)).toString('utf8');return[...xml.matchAll(/<(set|component|custom|bitmapData|bitmap)\b[^>]*\/>/gs)].map(([raw,tag])=>({tag,attributes:Object.fromEntries([...raw.matchAll(/([\w.]+)=(['"])(.*?)\2/gs)].map(m=>[m[1],m[3]]))}));});for(const row of exchangeStyleRows){const found=originals.filter(s=>s.tag===row.tag&&s.attributes.stylename===row.attributes.stylename);assert(found.some(s=>{try{assert.deepEqual(s.attributes,row.attributes);return true;}catch{return false;}}),'original style differs '+row.attributes.stylename);}return{file:path.split(/[\\/]/).at(-1),path,bytes:bytes.length,sha256:sha(bytes),verifiedDefinitions:56};}
export function inspectExchangeResources({projectRoot}){const cache=new Map(),inputs=[verifyOriginalStyles(projectRoot)],skins=[];for(const row of exchangeBitmapRows){let swf=cache.get(row.source);if(!swf){const path=resolve(projectRoot,row.source),bytes=pinned(path,row.sourceSha256);swf=scan(bytes);cache.set(row.source,swf);inputs.push({file:row.source.split('/').at(-1),path,bytes:bytes.length,sha256:sha(bytes)});}const original=swf.tags.find(t=>t.code===row.tagCode&&swf.body.readUInt16LE(t.bodyStart)===row.originalId);assert(original);assert.equal(sha(original.raw),row.tagSha256);const data=swf.body.subarray(original.bodyStart,original.bodyEnd);assert.equal(sha(data.subarray(2)),row.payloadSha256);let width,height;if(row.tagCode===36){width=data.readUInt16LE(3);height=data.readUInt16LE(5);}else{const jpg=data.subarray(row.tagCode===35?6:2);for(let i=0;i<jpg.length-8;i++)if(jpg[i]===255&&[192,193,194,195].includes(jpg[i+1])){height=jpg.readUInt16BE(i+5);width=jpg.readUInt16BE(i+7);break;}}assert(width>0&&height>0);const payload=Buffer.from(data);payload.writeUInt16LE(row.id);skins.push({...row,path:resolve(projectRoot,row.source),width,height,payload,tag:original});}assert.equal(skins.length,54);assert.equal(exchangeStyleRows.length,56);return{skins,styles:exchangeStyles(),report:{inputs,bitmapCount:54,styles:56,spriteCount:0,allOriginalPixelPayloadsPreserved:true,rawOriginalsUnchanged:true,network:false,swfExecuted:false,closure:'54 direct bitmap definitions from3 exact cached originals; no sprite or timeline animation',styleScope:'56 module-local style names; original fonts remapped to Microsoft YaHei at runtime',limitations:['Original14 categories/36 recipes/42 unknown outputs are not imported.','Local1 category/four recipes are authoritative game projections.','AVM2 and visual layout acceptance remain pending.']}};}
export function extractExchangeResources({projectRoot,outputDir}){assert(!existsSync(outputDir));const r=inspectExchangeResources({projectRoot});mkdirSync(outputDir,{recursive:true});writeFileSync(resolve(outputDir,'exchange-styles.xml'),r.styles,{flag:'wx'});writeFileSync(resolve(outputDir,'resources.json'),JSON.stringify(r.report,null,2)+'\n',{flag:'wx'});return r.report;}

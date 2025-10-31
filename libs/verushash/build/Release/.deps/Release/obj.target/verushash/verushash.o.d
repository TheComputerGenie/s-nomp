cmd_Release/obj.target/verushash/verushash.o := g++ '-DNODE_GYP_MODULE_NAME=verushash' '-DUSING_UV_SHARED=1' '-DUSING_V8_SHARED=1' '-DV8_DEPRECATION_WARNINGS=1' '-D_LARGEFILE_SOURCE' '-D_FILE_OFFSET_BITS=64' '-DOPENSSL_NO_PINSHARED' '-DNAPI_VERSION=8' '-DBUILDING_NODE_EXTENSION' -I/home/computergenie/.cache/node-gyp/10.24.1/include/node -I/home/computergenie/.cache/node-gyp/10.24.1/src -I/home/computergenie/.cache/node-gyp/10.24.1/deps/openssl/config -I/home/computergenie/.cache/node-gyp/10.24.1/deps/openssl/openssl/include -I/home/computergenie/.cache/node-gyp/10.24.1/deps/uv/include -I/home/computergenie/.cache/node-gyp/10.24.1/deps/zlib -I/home/computergenie/.cache/node-gyp/10.24.1/deps/v8/include -I/include/node  -fPIC -pthread -Wall -Wextra -Wno-unused-parameter -m64 -Wl,--whole-archive -Wno-unused-variable -fPIC -fexceptions -Ofast -march=native -msse4 -msse4.1 -msse4.2 -mssse3 -mavx -mpclmul -maes -O3 -fno-omit-frame-pointer -fno-rtti -fno-exceptions -std=gnu++1y -std=c++17 -Wl,--whole-archive -Wno-unused-variable -fPIC -fexceptions -Ofast -march=native -msse4 -msse4.1 -msse4.2 -mssse3 -mavx -mpclmul -maes -MMD -MF ./Release/.deps/Release/obj.target/verushash/verushash.o.d.raw   -c -o Release/obj.target/verushash/verushash.o ../verushash.cc
Release/obj.target/verushash/verushash.o: ../verushash.cc \
 /home/computergenie/.cache/node-gyp/10.24.1/include/node/node_api.h \
 /home/computergenie/.cache/node-gyp/10.24.1/include/node/node_api_types.h \
 ../crypto/verus_hash.h ../crypto/uint256.h ../crypto/verus_clhash.h \
 ../crypto/haraka.h ../crypto/haraka_portable.h ../crypto/blake2.h
../verushash.cc:
/home/computergenie/.cache/node-gyp/10.24.1/include/node/node_api.h:
/home/computergenie/.cache/node-gyp/10.24.1/include/node/node_api_types.h:
../crypto/verus_hash.h:
../crypto/uint256.h:
../crypto/verus_clhash.h:
../crypto/haraka.h:
../crypto/haraka_portable.h:
../crypto/blake2.h:
